import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('wishlist + recovery routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_wishlist_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: string;

  async function signup(username: string) {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/register').send({
      username, password: PASSWORD, storeNickname: username, email: `${username}@example.com`,
    })).status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
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
      `INSERT INTO scryfall_cards (id, name, card_name, price, type_line, oracle_text) VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001','Sol Ring','Sol Ring', 1.25,'Artifact','{T}: Add {C}{C}.'),
        ('aaaaaaaa-0000-4000-8000-000000000002','Sol Ring','Sol Ring', 3500,'Artifact','{T}: Add {C}{C}.'),
        ('bbbbbbbb-0000-4000-8000-000000000001','Lightning Bolt','Lightning Bolt', 2.5,'Instant','3 damage.')`,
    );
    await ctx.pool.query(`INSERT INTO card_price_cache (card_name, price, type_line) VALUES ('Lightning Bolt', 1.75, 'Instant')`);
    ({ agent: alice, id: aliceId } = await signup('alice_wish'));
    ({ agent: bob } = await signup('bob_wish'));
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
      anon.get('/api/wishlist'),
      anon.post('/api/wishlist').send({ cardName: 'Sol Ring' }),
      anon.put('/api/wishlist').send({ cardName: 'Sol Ring', quantity: 2 }),
      anon.delete('/api/wishlist/Sol%20Ring'),
      anon.get('/api/recovery/deleted-items'),
      anon.post('/api/recovery/restore/rec_1'),
      anon.delete('/api/recovery/deleted-items/rec_1'),
    ]) {
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('adds a card, resolving the cheapest printing (the table did not exist before migration 0008)', async () => {
    const r = await alice.post('/api/wishlist').send({ cardName: 'Sol Ring', quantity: 2 });
    expect(r.status).toBe(201);
    const rows = await ctx.pool.query('SELECT * FROM wishlist_cards WHERE player_id = $1', [aliceId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].quantity).toBe(2);
    expect(rows.rows[0].scryfall_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('increments the same card case-insensitively rather than duplicating it', async () => {
    // Legacy used COLLATE NOCASE here, which raises on Postgres.
    await alice.post('/api/wishlist').send({ cardName: 'sol ring', quantity: 1 });
    const rows = await ctx.pool.query('SELECT quantity FROM wishlist_cards WHERE player_id = $1', [aliceId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].quantity).toBe(3);
  });

  it('lists with prices, a total, and no fan-out', async () => {
    await alice.post('/api/wishlist').send({ cardName: 'Lightning Bolt', quantity: 4 });
    const r = await alice.get('/api/wishlist');
    expect(r.status).toBe(200);
    expect(r.body.wishlist).toHaveLength(2);
    const bolt = r.body.wishlist.find((w: { card_name: string }) => w.card_name === 'Lightning Bolt');
    expect(bolt.price).toBeCloseTo(1.75, 2); // cache row beats the scryfall row
    expect(bolt.type_line).toBe('Instant');
    expect(bolt.oracle_text).toBe('3 damage.');
    // 3 Sol Ring @ 1.25 + 4 Bolt @ 1.75 = 3.75 + 7 = 10.75
    expect(r.body.totalValue).toBeCloseTo(10.75, 2);
  });

  it('sets an exact quantity, and treats 0 as removal', async () => {
    const up = await alice.put('/api/wishlist').send({ cardName: 'Lightning Bolt', scryfallId: 'bbbbbbbb-0000-4000-8000-000000000001', quantity: 1 });
    expect(up.status).toBe(200);
    expect(up.body.card.quantity).toBe(1);
    const zero = await alice.put('/api/wishlist').send({ cardName: 'Lightning Bolt', scryfallId: 'bbbbbbbb-0000-4000-8000-000000000001', quantity: 0 });
    expect(zero.body.removed).toBe(true);
    expect((await alice.get('/api/wishlist')).body.wishlist).toHaveLength(1);
  });

  it('404s an update or delete that matches nothing', async () => {
    expect((await alice.put('/api/wishlist').send({ cardName: 'Black Lotus', quantity: 1 })).status).toBe(404);
    expect((await alice.delete('/api/wishlist/Black%20Lotus')).status).toBe(404);
  });

  it("keeps wishlists private to their owner", async () => {
    expect((await bob.get('/api/wishlist')).body.wishlist).toEqual([]);
    expect((await bob.delete('/api/wishlist/Sol%20Ring')).status).toBe(404);
    expect((await ctx.pool.query('SELECT quantity FROM wishlist_cards WHERE player_id = $1', [aliceId])).rows[0].quantity).toBe(3);
  });

  it('adding a wished card to a collection decrements the wish', async () => {
    const col = await alice.post('/api/collections').send({ name: 'Binder' });
    const colId = col.body.collectionId;
    // 3 wished, acquire 1 -> 2 left. This is what legacy intended and could never do.
    await alice.post(`/api/collections/${colId}/cards`).send({ card_name: 'Sol Ring', quantity: 1 });
    let rows = await ctx.pool.query('SELECT quantity FROM wishlist_cards WHERE player_id = $1', [aliceId]);
    expect(rows.rows[0].quantity).toBe(2);
    // Acquiring the rest clears the wish entirely rather than leaving a zero or negative row.
    await alice.post(`/api/collections/${colId}/cards`).send({ card_name: 'SOL RING', quantity: 5 });
    rows = await ctx.pool.query('SELECT * FROM wishlist_cards WHERE player_id = $1', [aliceId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('deletes are removed from the bin only after a successful restore', async () => {
    const deck = await alice.post('/api/decks/builder-save').send({
      deck_name: 'Recycle Me', is_public: false, format: 'commander', custom_tags: ['budget'],
      cards: [
        { card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 },
        { card_name: 'Mountain', quantity: 30, cheapest_card_price: 0.5 },
      ],
    });
    const deckId = deck.body.deckId;
    expect((await alice.delete(`/api/decks/${deckId}`)).status).toBe(200);

    const bin = await alice.get('/api/recovery/deleted-items');
    expect(bin.status).toBe(200);
    const entry = bin.body.items.find((i: { item_id: string }) => i.item_id === deckId);
    expect(entry.item_type).toBe('deck');
    expect(entry.name).toBe('Recycle Me');
    // The list must not carry the whole archived payload.
    expect(entry.data).toBeUndefined();

    const restore = await alice.post(`/api/recovery/restore/${entry.id}`);
    expect(restore.status).toBe(200);
    expect(restore.body.cards).toBe(2);
    // The archive is consumed only once the restore committed.
    expect((await alice.get('/api/recovery/deleted-items')).body.items).toEqual([]);
    expect((await alice.post(`/api/recovery/restore/${entry.id}`)).status).toBe(404);
  });

  it('restores a deck losslessly — commander, format, tags and visibility all survive', async () => {
    const restored = await ctx.pool.query(
      `SELECT deck_name, format, is_public, custom_tags, featured_card_name FROM decks WHERE deck_name = 'Recycle Me'`,
    );
    expect(restored.rows).toHaveLength(1);
    // Legacy's restore wrote eight columns and dropped the rest: format, tags and is_public were lost.
    expect(restored.rows[0].format).toBe('commander');
    expect(restored.rows[0].is_public).toBe(0);
    expect(JSON.parse(restored.rows[0].custom_tags)).toEqual(['budget']);
    expect(restored.rows[0].featured_card_name).toBe('Krenko, Mob Boss');

    const cards = await ctx.pool.query(
      `SELECT card_name, quantity, is_commander FROM deck_cards
       WHERE deck_id = (SELECT id FROM decks WHERE deck_name = 'Recycle Me') ORDER BY card_name`,
    );
    expect(cards.rows).toHaveLength(2);
    // The important one: legacy dropped is_commander, so a restored deck came back with no commander.
    expect(cards.rows.find((c) => c.card_name === 'Krenko, Mob Boss').is_commander).toBe(1);
    expect(cards.rows.find((c) => c.card_name === 'Mountain').quantity).toBe(30);
  });

  it('restores a collection with the columns legacy named wrongly', async () => {
    const col = await alice.post('/api/collections').send({ name: 'Trade Binder', is_public: false });
    const colId = col.body.collectionId;
    await alice.post(`/api/collections/${colId}/cards`).send({ card_name: 'Lightning Bolt', quantity: 2, condition: 'LP', is_for_trade: true, foil: true });
    await alice.delete(`/api/collections/${colId}`);

    const bin = await alice.get('/api/recovery/deleted-items');
    const entry = bin.body.items.find((i: { item_id: string }) => i.item_id === colId);
    expect((await alice.post(`/api/recovery/restore/${entry.id}`)).status).toBe(200);

    // Legacy named is_foil and added_at, neither of which exists on collection_cards.
    const cards = await ctx.pool.query(
      'SELECT card_name, quantity, foil, condition, is_for_trade FROM collection_cards WHERE collection_id = $1',
      [colId],
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0].foil).toBe(1);
    expect(cards.rows[0].condition).toBe('LP');
    expect(cards.rows[0].is_for_trade).toBe(1);
  });

  it("cannot restore or discard another player's archive", async () => {
    const deck = await alice.post('/api/decks/builder-save').send({ deck_name: 'Private Bin', cards: [{ card_name: 'Sol Ring' }] });
    await alice.delete(`/api/decks/${deck.body.deckId}`);
    const entry = (await alice.get('/api/recovery/deleted-items')).body.items[0];

    expect((await bob.get('/api/recovery/deleted-items')).body.items).toEqual([]);
    expect((await bob.post(`/api/recovery/restore/${entry.id}`)).status).toBe(404);
    expect((await bob.delete(`/api/recovery/deleted-items/${entry.id}`)).status).toBe(404);

    // The owner can discard it permanently — legacy had no way to empty the bin at all.
    expect((await alice.delete(`/api/recovery/deleted-items/${entry.id}`)).status).toBe(200);
    expect((await alice.get('/api/recovery/deleted-items')).body.items).toEqual([]);
  });

  it('refuses a restore whose target already exists, instead of 500ing', async () => {
    const deck = await alice.post('/api/decks/builder-save').send({ deck_name: 'Clash', cards: [{ card_name: 'Sol Ring' }] });
    const deckId = deck.body.deckId;
    await alice.delete(`/api/decks/${deckId}`);
    const entry = (await alice.get('/api/recovery/deleted-items')).body.items[0];
    // Something else takes the id back before the restore runs.
    await ctx.pool.query(
      `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, is_public)
       VALUES ($1, $2, $3, 'Squatter', 0, 0)`,
      [deckId, aliceId, 'visual-' + deckId],
    );
    const r = await alice.post(`/api/recovery/restore/${entry.id}`);
    expect(r.status).toBe(409);
    // The archive survives a failed restore, so nothing is lost.
    expect((await alice.get('/api/recovery/deleted-items')).body.items).toHaveLength(1);
  });

  it('reports an unreadable archive rather than failing opaquely', async () => {
    await ctx.pool.query(
      `INSERT INTO deleted_items (id, item_type, item_id, player_id, name, data)
       VALUES ('rec_corrupt', 'deck', 'd_gone', $1, 'Corrupt', 'not json')`,
      [aliceId],
    );
    const r = await alice.post('/api/recovery/restore/rec_corrupt');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CORRUPT_ARCHIVE');
  });
});
