import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('decks routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_decks_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: string;
  let bobId: string;

  const cards = [
    { card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 },
    { card_name: 'Goblin Guide', quantity: 1, cheapest_card_price: 1.25 },
    { card_name: 'Mountain', quantity: 30, cheapest_card_price: 0.5 },
  ];

  async function signup(username: string) {
    const agent = request.agent(app);
    const reg = await agent
      .post('/api/auth/register')
      .send({ username, password: 'correct-horse-battery', storeNickname: username, email: `${username}@example.com` });
    expect(reg.status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    return { agent, id: login.body.user.id as string };
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
    ({ agent: alice, id: aliceId } = await signup('alice_decks'));
    ({ agent: bob, id: bobId } = await signup('bob_decks'));
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('rejects unauthenticated mutations with 401 UNAUTHENTICATED', async () => {
    const anon = request(app);
    for (const r of [
      anon.post('/api/decks/builder-save').send({ deck_name: 'x' }),
      anon.post('/api/decks/whatever/like'),
      anon.post('/api/decks/whatever/comment').send({ commentText: 'hi' }),
      anon.post('/api/decks/whatever/tags').send({ tags: [] }),
      anon.post('/api/decks/whatever/clone'),
      anon.post('/api/decks/whatever/cards').send({ name: 'Island' }),
      anon.delete('/api/decks/whatever'),
      anon.get('/api/decks/my-decks'),
    ]) {
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  let privateDeckId: string;
  let publicDeckId: string;

  it('builder-save creates a deck with 3 cards atomically', async () => {
    const r = await alice.post('/api/decks/builder-save').send({ deck_name: 'Goblins', is_public: false, cards });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    privateDeckId = r.body.deckId;
    expect(privateDeckId).toMatch(/^d_/);

    const rows = await ctx.pool.query('SELECT card_name, quantity, is_commander, cheapest_card_price FROM deck_cards WHERE deck_id = $1 ORDER BY card_name', [privateDeckId]);
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.find((c) => c.card_name === 'Krenko, Mob Boss').is_commander).toBe(1);
    // Basics are priced at 0 regardless of the client price
    expect(rows.rows.find((c) => c.card_name === 'Mountain').cheapest_card_price).toBe(0);

    const deck = await ctx.pool.query('SELECT cheapest_total_price, featured_card_name, is_public, moxfield_url FROM decks WHERE id = $1', [privateDeckId]);
    expect(deck.rows[0].cheapest_total_price).toBeCloseTo(3.75, 2);
    expect(deck.rows[0].featured_card_name).toBe('Krenko, Mob Boss');
    expect(deck.rows[0].is_public).toBe(0);
    expect(deck.rows[0].moxfield_url).toBe('visual-' + privateDeckId);

    const pub = await alice.post('/api/decks/builder-save').send({ deck_name: 'Public Goblins', cards, custom_tags: ['aggro'] });
    expect(pub.status).toBe(200);
    publicDeckId = pub.body.deckId;
  });

  it('a failing save leaves the previous cards intact', async () => {
    const bad = await alice
      .post('/api/decks/builder-save')
      .send({ deckId: privateDeckId, deck_name: 'Goblins v2', cards: [{ card_name: 'Skirk Prospector' }, { card_name: 'a', quantity: 0 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');

    const rows = await ctx.pool.query('SELECT card_name FROM deck_cards WHERE deck_id = $1 ORDER BY card_name', [privateDeckId]);
    expect(rows.rows.map((r) => r.card_name)).toEqual(['Goblin Guide', 'Krenko, Mob Boss', 'Mountain']);
    const name = await ctx.pool.query('SELECT deck_name FROM decks WHERE id = $1', [privateDeckId]);
    expect(name.rows[0].deck_name).toBe('Goblins');
  });

  it('builder-save with a deckId replaces the card list (and only for the owner)', async () => {
    const steal = await bob.post('/api/decks/builder-save').send({ deckId: privateDeckId, deck_name: 'Mine now', cards: [] });
    expect(steal.status).toBe(404); // private deck: existence hidden from non-owners
    const stealPublic = await bob.post('/api/decks/builder-save').send({ deckId: publicDeckId, deck_name: 'Mine now', cards: [] });
    expect(stealPublic.status).toBe(403);

    const upd = await alice
      .post('/api/decks/builder-save')
      .send({ deckId: privateDeckId, deck_name: 'Goblins v2', is_public: false, cards: [cards[0], { card_name: 'Skirk Prospector', cheapest_card_price: 0.2 }] });
    expect(upd.status).toBe(200);
    expect(upd.body.deckId).toBe(privateDeckId);
    const rows = await ctx.pool.query('SELECT card_name FROM deck_cards WHERE deck_id = $1 ORDER BY card_name', [privateDeckId]);
    expect(rows.rows.map((r) => r.card_name)).toEqual(['Krenko, Mob Boss', 'Skirk Prospector']);
    // Bob's failed attempt did not create a stray deck (legacy would have)
    const bobDecks = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM decks WHERE player_id = $1', [bobId]);
    expect(bobDecks.rows[0].n).toBe(0);
  });

  it('owner can read a private deck; other users and anonymous get 404', async () => {
    const mine = await alice.get(`/api/decks/${privateDeckId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.deck_name).toBe('Goblins v2');
    expect(mine.body.name).toBe('Goblins v2');
    expect(mine.body.is_public).toBe(false);
    expect(mine.body.cards).toHaveLength(2);
    expect(mine.body.cards[0].card_name).toBe('Krenko, Mob Boss'); // commander first
    expect(mine.body.commander).toEqual({ name: 'Krenko, Mob Boss', scryfallId: null });
    expect(mine.body.stats.total_wins).toBe(0);
    expect(mine.body.creator_name).toBe('alice_decks');

    expect((await bob.get(`/api/decks/${privateDeckId}`)).status).toBe(404);
    expect((await bob.get(`/api/decks/${privateDeckId}/cards`)).status).toBe(404);
    expect((await bob.get(`/api/decks/${privateDeckId}/social`)).status).toBe(404);
    expect((await request(app).get(`/api/decks/${privateDeckId}`)).status).toBe(404);
    expect((await request(app).get(`/api/decks/does-not-exist`)).status).toBe(404);

    const pub = await request(app).get(`/api/decks/${publicDeckId}/cards`);
    expect(pub.status).toBe(200);
    expect(pub.body).toHaveLength(3);
  });

  it('my-decks lists only the caller\'s decks', async () => {
    const r = await alice.get('/api/decks/my-decks');
    expect(r.status).toBe(200);
    expect(r.body.map((d: { id: string }) => d.id).sort()).toEqual([privateDeckId, publicDeckId].sort());
    expect(r.body[0].name).toBe(r.body[0].deck_name);
    expect((await bob.get('/api/decks/my-decks')).body).toEqual([]);
  });

  it('discover lists only public decks, with pagination and filters', async () => {
    // A couple more public decks from bob so pagination has something to page over
    for (const n of ['Bob One', 'Bob Two']) {
      const r = await bob.post('/api/decks/builder-save').send({ deck_name: n, format: 'modern', cards: [{ card_name: 'Island' }] });
      expect(r.status).toBe(200);
    }
    const all = await request(app).get('/api/decks');
    expect(all.status).toBe(200);
    expect(all.body.meta).toEqual({ page: 1, limit: 20, total: 3, hasMore: false });
    const ids = all.body.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(publicDeckId);
    expect(ids).not.toContain(privateDeckId);
    expect(all.body.items[0].name).toBe('Bob Two'); // newest first
    expect(all.body.items.find((d: { id: string }) => d.id === publicDeckId).commander_name).toBe('Krenko, Mob Boss');
    expect(all.body.items.find((d: { id: string }) => d.id === publicDeckId).custom_tags).toEqual(['aggro']);

    const page2 = await request(app).get('/api/decks?limit=2&page=2');
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.meta).toEqual({ page: 2, limit: 2, total: 3, hasMore: false });
    const page1 = await request(app).get('/api/decks?limit=2&page=1');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.meta.hasMore).toBe(true);

    const modern = await request(app).get('/api/decks?format=modern');
    expect(modern.body.meta.total).toBe(2);
    const search = await request(app).get('/api/decks?q=krenko');
    expect(search.body.items.map((d: { id: string }) => d.id)).toEqual([publicDeckId]);

    expect((await request(app).get('/api/decks?limit=500')).status).toBe(400);
    expect((await request(app).get('/api/decks?sort=bogus')).status).toBe(400);
  });

  it('like toggles and keeps likes_count in sync', async () => {
    const on = await bob.post(`/api/decks/${publicDeckId}/like`);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ success: true, liked: true, likes_count: 1 });
    const again = await alice.post(`/api/decks/${publicDeckId}/like`);
    expect(again.body.likes_count).toBe(2);

    const social = await bob.get(`/api/decks/${publicDeckId}/social`);
    expect(social.body.likes).toBe(2);
    expect(social.body.hasLiked).toBe(true);
    expect(social.body.isOwner).toBe(false);
    const list = await request(app).get('/api/decks?sort=likes');
    expect(list.body.items[0].id).toBe(publicDeckId);
    expect(list.body.items[0].likes_count).toBe(2);
    const asBob = await bob.get('/api/decks?sort=likes');
    expect(asBob.body.items[0].has_liked).toBe(true);

    const off = await bob.post(`/api/decks/${publicDeckId}/like`);
    expect(off.body).toEqual({ success: true, liked: false, likes_count: 1 });
    const row = await ctx.pool.query('SELECT likes_count FROM decks WHERE id = $1', [publicDeckId]);
    expect(row.rows[0].likes_count).toBe(1);

    // Cannot like a private deck you can't see
    expect((await bob.post(`/api/decks/${privateDeckId}/like`)).status).toBe(404);
  });

  it('comment appears in social', async () => {
    const c = await bob.post(`/api/decks/${publicDeckId}/comment`).send({ commentText: '  Nice goblins!  ' });
    expect(c.status).toBe(201);
    expect(c.body.comment.comment_text).toBe('Nice goblins!');
    expect((await bob.post(`/api/decks/${publicDeckId}/comment`).send({ commentText: '   ' })).status).toBe(400);
    expect((await bob.post(`/api/decks/${publicDeckId}/comment`).send({ commentText: 'x'.repeat(1001) })).status).toBe(400);

    const social = await request(app).get(`/api/decks/${publicDeckId}/social`);
    expect(social.status).toBe(200);
    expect(social.body.comments).toHaveLength(1);
    expect(social.body.comments[0]).toMatchObject({ comment_text: 'Nice goblins!', player_id: bobId, store_nickname: 'bob_decks' });
    expect(social.body.customTags).toEqual(['aggro']);
    expect(social.body.hasLiked).toBe(false);
  });

  it('tags are owner-only and replace custom_tags', async () => {
    expect((await bob.post(`/api/decks/${publicDeckId}/tags`).send({ tags: ['hax'] })).status).toBe(403);
    const r = await alice.post(`/api/decks/${publicDeckId}/tags`).send({ tags: ['aggro', 'tribal'] });
    expect(r.status).toBe(200);
    expect(r.body.tags).toEqual(['aggro', 'tribal']);
    const social = await request(app).get(`/api/decks/${publicDeckId}/social`);
    expect(social.body.customTags).toEqual(['aggro', 'tribal']);
  });

  it('quick-add increments quantity and recomputes the total', async () => {
    expect((await bob.post(`/api/decks/${publicDeckId}/cards`).send({ name: 'Island' })).status).toBe(403);
    const first = await alice.post(`/api/decks/${publicDeckId}/cards`).send({ name: 'Lightning Bolt', price: 1 });
    expect(first.body).toEqual({ success: true, quantity: 1 });
    const second = await alice.post(`/api/decks/${publicDeckId}/cards`).send({ name: 'lightning bolt', price: 1 });
    expect(second.body.quantity).toBe(2);
    const deck = await alice.get(`/api/decks/${publicDeckId}`);
    expect(deck.body.card_count).toBe(4);
    expect(deck.body.cheapest_total_price).toBeCloseTo(3.75 + 2, 2);
  });

  it('clone copies the cards to the second user as a private deck', async () => {
    const r = await bob.post(`/api/decks/${publicDeckId}/clone`);
    expect(r.status).toBe(201);
    const cloneId = r.body.newDeckId;
    expect(cloneId).not.toBe(publicDeckId);

    const clone = await bob.get(`/api/decks/${cloneId}`);
    expect(clone.status).toBe(200);
    expect(clone.body.player_id).toBe(bobId);
    expect(clone.body.deck_name).toBe('Public Goblins (Copy)');
    expect(clone.body.is_public).toBe(false);
    expect(clone.body.cloned_from_deck_id).toBe(publicDeckId);
    expect(clone.body.original_creator_name).toBe('alice_decks');
    expect(clone.body.custom_tags).toEqual(['aggro', 'tribal']);
    expect(clone.body.cards.map((c: { card_name: string; quantity: number }) => [c.card_name, c.quantity])).toEqual([
      ['Krenko, Mob Boss', 1],
      ['Goblin Guide', 1],
      ['Lightning Bolt', 2],
      ['Mountain', 30],
    ]);
    // Source untouched, clone counted
    expect((await request(app).get(`/api/decks/${publicDeckId}`)).body.clones_count).toBe(1);
    expect((await alice.get(`/api/decks/${cloneId}`)).status).toBe(404);
    // Cannot clone a private deck you can't see
    expect((await bob.post(`/api/decks/${privateDeckId}/clone`)).status).toBe(404);
  });

  it('delete soft-deletes into deleted_items and hides the deck from lists', async () => {
    expect((await bob.delete(`/api/decks/${publicDeckId}`)).status).toBe(403);
    expect((await alice.delete(`/api/decks/nope`)).status).toBe(404);

    const r = await alice.delete(`/api/decks/${publicDeckId}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });

    expect((await alice.get(`/api/decks/${publicDeckId}`)).status).toBe(404);
    const list = await request(app).get('/api/decks');
    expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(publicDeckId);
    const mine = await alice.get('/api/decks/my-decks');
    expect(mine.body.map((d: { id: string }) => d.id)).toEqual([privateDeckId]);

    const archived = await ctx.pool.query("SELECT item_id, player_id, name, data FROM deleted_items WHERE item_type = 'deck'");
    expect(archived.rowCount).toBe(1);
    expect(archived.rows[0]).toMatchObject({ item_id: publicDeckId, player_id: aliceId, name: 'Public Goblins' });
    const data = JSON.parse(archived.rows[0].data);
    expect(data.deck.id).toBe(publicDeckId);
    expect(data.cards).toHaveLength(4);
    expect((await ctx.pool.query('SELECT 1 FROM deck_cards WHERE deck_id = $1', [publicDeckId])).rowCount).toBe(0);
    expect((await ctx.pool.query('SELECT 1 FROM deck_likes WHERE deck_id = $1', [publicDeckId])).rowCount).toBe(0);
    expect((await ctx.pool.query('SELECT 1 FROM deck_comments WHERE deck_id = $1', [publicDeckId])).rowCount).toBe(0);
  });
});
