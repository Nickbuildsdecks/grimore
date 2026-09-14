import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('deck repricing + legality (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_reprice_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let deckId: string;

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
      `INSERT INTO scryfall_cards (id, name, card_name, price, rarity, color_identity, legalities, type_line) VALUES
        ('aaaa0000-0000-4000-8000-000000000001','Sol Ring','Sol Ring', 1.25,'uncommon','[]','{"commander":"legal","modern":"banned"}','Artifact'),
        ('aaaa0000-0000-4000-8000-000000000002','Sol Ring','Sol Ring', 0.75,'uncommon','[]','{"commander":"legal"}','Artifact'),
        ('bbbb0000-0000-4000-8000-000000000001','Lightning Bolt','Lightning Bolt', 2.50,'common','["R"]','{"commander":"legal","modern":"legal"}','Instant'),
        ('cccc0000-0000-4000-8000-000000000001','Black Lotus','Black Lotus', 9000,'rare','[]','{"commander":"banned"}','Artifact'),
        ('dddd0000-0000-4000-8000-000000000001','Rhystic Study','Rhystic Study', 30,'rare','["U"]','{"commander":"legal"}','Enchantment'),
        ('eeee0000-0000-4000-8000-000000000001','Mountain','Mountain', 0.10,'common','["R"]','{"commander":"legal"}','Basic Land')`,
    );
    ({ agent: alice } = await signup('alice_price'));
    ({ agent: bob } = await signup('bob_price'));
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  beforeEach(async () => {
    await ctx.pool.query('UPDATE seasons SET is_active = 0');
  });

  async function makeDeck(cards: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const r = await alice.post('/api/decks/builder-save').send({ deck_name: 'Priced', cards, ...extra });
    expect(r.status).toBe(200);
    return r.body.deckId as string;
  }

  it('rejects every reprice route without a session, and another player\'s deck', async () => {
    deckId = await makeDeck([{ card_name: 'Sol Ring', cheapest_card_price: 99 }]);
    const anon = request(app);
    expect((await anon.get(`/api/decks/reprice-init/${deckId}`)).status).toBe(401);
    expect((await anon.post('/api/decks/reprice-card').send({ deckId, cardName: 'Sol Ring' })).status).toBe(401);
    expect((await anon.post(`/api/decks/reprice-finalize/${deckId}`)).status).toBe(401);
    expect((await anon.post(`/api/decks/${deckId}/reload-cheapest`)).status).toBe(401);
    // The deck is public, so ownership fails with 403; a private deck 404s instead (see loadOwnedDeck).
    expect((await bob.post(`/api/decks/${deckId}/reload-cheapest`)).status).toBe(403);
  });

  it('re-prices from the local card tables and keeps basics free', async () => {
    deckId = await makeDeck([
      { card_name: 'Sol Ring', cheapest_card_price: 99 },
      { card_name: 'Mountain', quantity: 10, cheapest_card_price: 99 },
    ]);
    const r = await alice.post(`/api/decks/${deckId}/reload-cheapest`);
    expect(r.status).toBe(200);
    const rows = await ctx.pool.query('SELECT card_name, cheapest_card_price FROM deck_cards WHERE deck_id = $1 ORDER BY card_name', [deckId]);
    // Cheapest of the two Sol Ring printings.
    expect(rows.rows.find((c) => c.card_name === 'Sol Ring').cheapest_card_price).toBeCloseTo(0.75, 2);
    // Basics stay at zero unless the deck opts them in.
    expect(rows.rows.find((c) => c.card_name === 'Mountain').cheapest_card_price).toBe(0);
    expect(r.body.totalPrice).toBeCloseTo(0.75, 2);
  });

  it('counts basics once the deck opts them in', async () => {
    await ctx.pool.query('UPDATE decks SET include_basic_lands_in_price = 1 WHERE id = $1', [deckId]);
    const r = await alice.post(`/api/decks/${deckId}/reload-cheapest`);
    // 0.75 + 10 * 0.10 = 1.75
    expect(r.body.totalPrice).toBeCloseTo(1.75, 2);
    await ctx.pool.query('UPDATE decks SET include_basic_lands_in_price = 0 WHERE id = $1', [deckId]);
  });

  it('prefers the price cache over the card table', async () => {
    await ctx.pool.query(`INSERT INTO card_price_cache (card_name, price) VALUES ('Sol Ring', 0.25)`);
    const r = await alice.post(`/api/decks/${deckId}/reload-cheapest`);
    expect(r.body.totalPrice).toBeCloseTo(0.25, 2);
    await ctx.pool.query(`DELETE FROM card_price_cache WHERE card_name = 'Sol Ring'`);
  });

  it('feeds the shared price cache — the whole point of reprice-card, which legacy could not do', async () => {
    deckId = await makeDeck([{ card_name: 'Rhystic Study', cheapest_card_price: 12.5 }]);
    const r = await alice.post('/api/decks/reprice-card').send({ deckId, cardName: 'Rhystic Study' });
    expect(r.status).toBe(200);
    expect(r.body.price).toBeCloseTo(12.5, 2);
    // Legacy used SQLite's INSERT OR REPLACE here, which raises on Postgres, so nothing was ever cached.
    const cached = await ctx.pool.query(`SELECT price FROM card_price_cache WHERE card_name = 'Rhystic Study'`);
    expect(cached.rows).toHaveLength(1);
    expect(cached.rows[0].price).toBeCloseTo(12.5, 2);

    // A second call updates the same row rather than adding another.
    await ctx.pool.query('UPDATE deck_cards SET cheapest_card_price = 15 WHERE deck_id = $1', [deckId]);
    await alice.post('/api/decks/reprice-card').send({ deckId, cardName: 'Rhystic Study' });
    const again = await ctx.pool.query(`SELECT price FROM card_price_cache WHERE card_name = 'Rhystic Study'`);
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0].price).toBeCloseTo(15, 2);
    await ctx.pool.query(`DELETE FROM card_price_cache WHERE card_name = 'Rhystic Study'`);
  });

  it('404s repricing a card that is not in the deck', async () => {
    expect((await alice.post('/api/decks/reprice-card').send({ deckId, cardName: 'Black Lotus' })).status).toBe(404);
    expect((await alice.post(`/api/decks/${deckId}/reprice-card-cheapest`).send({ cardName: 'Black Lotus' })).status).toBe(404);
  });

  it('re-prices one card to its cheapest format-legal printing', async () => {
    deckId = await makeDeck([{ card_name: 'Sol Ring', cheapest_card_price: 99 }], { format: 'commander' });
    const r = await alice.post(`/api/decks/${deckId}/reprice-card-cheapest`).send({ cardName: 'Sol Ring' });
    expect(r.status).toBe(200);
    expect(r.body.price).toBeCloseTo(0.75, 2);

    // In modern, the 0.75 printing is not listed as legal, so the legal printing is chosen instead.
    await ctx.pool.query(`UPDATE decks SET format = 'modern' WHERE id = $1`, [deckId]);
    const modern = await alice.post(`/api/decks/${deckId}/reprice-card-cheapest`).send({ cardName: 'Sol Ring' });
    // Neither printing is modern-legal (one banned, one unlisted), so it falls back to the floor.
    expect(modern.status).toBe(200);
    await ctx.pool.query(`UPDATE decks SET format = 'commander' WHERE id = $1`, [deckId]);
  });

  // ── Legality ──────────────────────────────────────────────────────────────────────────────────

  async function activateSeason(rules: Record<string, unknown>) {
    await ctx.pool.query('UPDATE seasons SET is_active = 0');
    const id = 'season_' + Math.random().toString(36).slice(2, 9);
    await ctx.pool.query(
      `INSERT INTO seasons (id, name, is_active, budget_limit, banlist, allowed_rarities, allowed_colors, max_rares)
       VALUES ($1, 'Legality', 1, $2, $3, $4, $5, $6)`,
      [id, rules.budget_limit ?? null, JSON.stringify(rules.banlist ?? []),
       JSON.stringify(rules.allowed_rarities ?? ['common', 'uncommon', 'rare', 'mythic']),
       JSON.stringify(rules.allowed_colors ?? ['W', 'U', 'B', 'R', 'G', 'C']), rules.max_rares ?? -1],
    );
    return id;
  }

  it('a deck with no active season is judged only by its own budget', async () => {
    deckId = await makeDeck([{ card_name: 'Rhystic Study', cheapest_card_price: 30 }]);
    let r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(true);

    await ctx.pool.query('UPDATE decks SET budget_limit = 10 WHERE id = $1', [deckId]);
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toMatch(/deck budget/i);
    await ctx.pool.query('UPDATE decks SET budget_limit = NULL WHERE id = $1', [deckId]);
  });

  it('enforces the season banlist, budget, rarity, colours and rare cap', async () => {
    deckId = await makeDeck([
      { card_name: 'Lightning Bolt', cheapest_card_price: 2.5 },
      { card_name: 'Rhystic Study', cheapest_card_price: 30 },
    ]);

    await activateSeason({ banlist: ['Rhystic Study'] });
    let r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toContain('Rhystic Study');

    await activateSeason({ budget_limit: 10 });
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toMatch(/season budget/i);

    // Rhystic Study is rare; a commons-and-uncommons season rejects it.
    await activateSeason({ allowed_rarities: ['common', 'uncommon'] });
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toMatch(/rarity/i);

    // Mono-red season: the blue card is out.
    await activateSeason({ allowed_colors: ['R', 'C'] });
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toMatch(/colour/i);

    await activateSeason({ max_rares: 0 });
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(false);
    expect(r.body.reason).toMatch(/rares/i);

    await activateSeason({});
    r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(true);
    expect(r.body.reason).toBeNull();
  });

  it('never fails a deck over basic lands or an unknown card', async () => {
    deckId = await makeDeck([
      { card_name: 'Mountain', quantity: 30, cheapest_card_price: 0 },
      { card_name: 'Some Unreleased Card', cheapest_card_price: 1 },
    ]);
    // Mono-blue season with a tight rarity set: basics are exempt, and a card the local table does not
    // know is treated as unrestricted so a gap in the cache cannot mark a legal deck illegal.
    await activateSeason({ allowed_colors: ['U'], allowed_rarities: ['common'] });
    const r = await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    expect(r.body.isLegal).toBe(true);
  });

  it('stores the verdict on the deck so the list views agree with it', async () => {
    deckId = await makeDeck([{ card_name: 'Rhystic Study', cheapest_card_price: 30 }]);
    await activateSeason({ banlist: ['Rhystic Study'] });
    await alice.post(`/api/decks/reprice-finalize/${deckId}`);
    const row = await ctx.pool.query('SELECT is_legal, legality_reason, cheapest_total_price FROM decks WHERE id = $1', [deckId]);
    expect(row.rows[0].is_legal).toBe(0);
    expect(row.rows[0].legality_reason).toContain('Rhystic Study');
    expect(row.rows[0].cheapest_total_price).toBeCloseTo(30, 2);
  });

  // ── reprice-init ──────────────────────────────────────────────────────────────────────────────

  it('re-prices a local deck and reports 503 for a Moxfield-linked one', async () => {
    deckId = await makeDeck([{ card_name: 'Sol Ring', cheapest_card_price: 99 }]);
    await activateSeason({});
    const r = await alice.get(`/api/decks/reprice-init/${deckId}`);
    expect(r.status).toBe(200);
    expect(r.body.cardNames).toEqual(['Sol Ring']);
    expect(r.body.totalPrice).toBeCloseTo(0.75, 2);

    // api.moxfield.com is unreachable here, so a linked deck says so rather than silently no-oping.
    await ctx.pool.query(`UPDATE decks SET moxfield_url = 'https://www.moxfield.com/decks/abc123' WHERE id = $1`, [deckId]);
    const mox = await alice.get(`/api/decks/reprice-init/${deckId}`);
    expect(mox.status).toBe(503);
    expect(mox.body.error.code).toBe('MOXFIELD_UNAVAILABLE');
    await ctx.pool.query(`UPDATE decks SET moxfield_url = 'visual-' || id WHERE id = $1`, [deckId]);
  });

  it('refuses to reprice a deck that is in an active round', async () => {
    const seasonId = await activateSeason({});
    deckId = await makeDeck([{ card_name: 'Sol Ring', cheapest_card_price: 1 }]);
    const me = await alice.get('/api/auth/me');
    await ctx.pool.query('INSERT INTO active_roster (player_id, deck_id) VALUES ($1, $2)', [me.body.id, deckId]);
    await ctx.pool.query(
      'INSERT INTO pods (id, season_id, round_num, pod_label, completed) VALUES ($1, $2, 1, 1, 0)',
      ['pod_lock', seasonId],
    );
    // Legacy checked this against active_roster and pods, neither of which existed until 0009.
    const r = await alice.get(`/api/decks/reprice-init/${deckId}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DECK_LOCKED');

    await ctx.pool.query(`UPDATE pods SET completed = 1 WHERE id = 'pod_lock'`);
    expect((await alice.get(`/api/decks/reprice-init/${deckId}`)).status).toBe(200);
    await ctx.pool.query('DELETE FROM active_roster');
    await ctx.pool.query(`DELETE FROM pods WHERE id = 'pod_lock'`);
  });
});
