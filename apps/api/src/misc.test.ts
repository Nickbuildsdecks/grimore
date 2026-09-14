import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('long-tail routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_misc_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let aliceId: string;

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
      `INSERT INTO scryfall_cards (id, name, card_name, type_line, oracle_text, mana_cost, cmc, rarity, set_code, price) VALUES
        ('aaaa0000-0000-4000-8000-000000000001','Cultivate','Cultivate','Sorcery','Search your library for two basic land cards.','{2}{G}',3,'uncommon','m21',0.5),
        ('bbbb0000-0000-4000-8000-000000000002','Rampant Growth','Rampant Growth','Sorcery','Search your library for a basic land card.','{1}{G}',2,'common','m10',0.3),
        ('cccc0000-0000-4000-8000-000000000003','Sol Ring','Sol Ring','Artifact','{T}: Add {C}{C}.','{1}',1,'uncommon','c21',1.25),
        ('dddd0000-0000-4000-8000-000000000004','Search for Azcanta','Search for Azcanta','Legendary Enchantment','Look at the top card of your library.','{1}{U}',2,'rare','xln',12),
        ('eeee0000-0000-4000-8000-000000000005','Goblin Token','Goblin Token','Token Creature — Goblin','','',0,'common','tm13',0.05)`,
    );
    alice = request.agent(app);
    expect((await alice.post('/api/auth/register').send({
      username: 'alice_misc', password: PASSWORD, storeNickname: 'alice_misc', email: 'alice_misc@example.com',
    })).status).toBe(201);
    const login = await alice.post('/api/auth/login').send({ username: 'alice_misc', password: PASSWORD });
    aliceId = login.body.user.id;
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('serves the documented affiliate id, not a placeholder', async () => {
    const r = await request(app).get('/api/config/affiliates');
    expect(r.status).toBe(200);
    // Legacy defaulted to 'grimore', which is not a real affiliate id, so an unset env var silently
    // broke attribution on every purchase link in the product.
    expect(r.body.tcgplayerAffiliateId).toBe('xJoE0d');
  });

  it('follows and unfollows an illustrator, folding case and punctuation', async () => {
    expect((await request(app).post('/api/artists/follow').send({ artist: 'Rebecca Guay', following: true })).status).toBe(401);

    expect((await alice.post('/api/artists/follow').send({ artist: 'Rebecca Guay', following: true })).status).toBe(200);
    // "rebecca  guay" is the same illustrator, so this updates rather than adding a second row.
    await alice.post('/api/artists/follow').send({ artist: 'rebecca  guay', following: true });
    const rows = await ctx.pool.query('SELECT artist_key, artist_name FROM artist_follows WHERE player_id = $1', [aliceId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].artist_key).toBe('rebecca guay');

    const list = await alice.get('/api/artists/followed');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('rebecca  guay');

    expect((await alice.post('/api/artists/follow').send({ artist: 'REBECCA GUAY', following: false })).status).toBe(200);
    expect((await alice.get('/api/artists/followed')).body).toEqual([]);
  });

  it('caches a sample printing, but only from the Scryfall CDN', async () => {
    const good = await alice.post('/api/artists/follow').send({
      artist: 'Mark Tedin',
      following: true,
      printing: {
        scryfallId: 'cccc0000-0000-4000-8000-000000000003',
        cardName: 'Sol Ring',
        imageUri: 'https://cards.scryfall.io/normal/front/c/c/cccc0000.jpg',
        setName: 'Commander 2021',
      },
    });
    expect(good.status).toBe(200);
    const cached = await ctx.pool.query('SELECT artist_name, set_name FROM followed_artist_printings');
    expect(cached.rows[0]).toMatchObject({ artist_name: 'Mark Tedin', set_name: 'Commander 2021' });

    // An arbitrary URL must not be storable through a follow.
    const bad = await alice.post('/api/artists/follow').send({
      artist: 'Mark Tedin',
      following: true,
      printing: {
        scryfallId: 'cccc0000-0000-4000-8000-000000000003',
        cardName: 'Sol Ring',
        imageUri: 'https://evil.example.com/tracker.gif',
      },
    });
    expect(bad.status).toBe(400);
  });

  it('rejects a malformed follow', async () => {
    expect((await alice.post('/api/artists/follow').send({ artist: '', following: true })).status).toBe(400);
    expect((await alice.post('/api/artists/follow').send({ artist: 'X', following: 'yes' })).status).toBe(400);
    expect((await alice.post('/api/artists/follow').send({ artist: '...', following: true })).status).toBe(400);
  });

  it('records a preference event with the right signal weight', async () => {
    expect((await request(app).post('/api/preferences/events').send({
      eventType: 'search', entityType: 'query', entityKey: 'ramp',
    })).status).toBe(401);

    const r = await alice.post('/api/preferences/events').send({
      eventType: 'recommendation_like', entityType: 'card', entityKey: 'Cultivate', source: 'discover',
    });
    expect(r.status).toBe(201);
    expect(r.body.signal).toBe(1.5);
    const rows = await ctx.pool.query(
      'SELECT event_type, entity_key, signal, source FROM preference_events WHERE player_id = $1',
      [aliceId],
    );
    expect(rows.rows[0]).toMatchObject({ event_type: 'recommendation_like', entity_key: 'Cultivate', source: 'discover' });
    expect(rows.rows[0].signal).toBeCloseTo(1.5, 2);

    // A dismissal is a negative signal, not an absent one.
    const down = await alice.post('/api/preferences/events').send({
      eventType: 'recommendation_dismiss', entityType: 'card', entityKey: 'Sol Ring',
    });
    expect(down.body.signal).toBe(-1.5);
  });

  it('rejects an unsupported event type or entity', async () => {
    expect((await alice.post('/api/preferences/events').send({
      eventType: 'nonsense', entityType: 'card', entityKey: 'x',
    })).status).toBe(400);
    expect((await alice.post('/api/preferences/events').send({
      eventType: 'search', entityType: 'planet', entityKey: 'x',
    })).status).toBe(400);
  });

  it('searches across name, type and rules text, ranking name hits highest', async () => {
    const r = await request(app).get('/api/search/semantic?q=search library basic land');
    expect(r.status).toBe(200);
    const names = r.body.map((c: { name: string }) => c.name);
    // Both ramp spells match every term in their rules text.
    expect(names).toContain('Cultivate');
    expect(names).toContain('Rampant Growth');
    // "Search for Azcanta" has the word in its NAME but not the other terms, so it is excluded by the
    // keyword AND rather than floated to the top by a name match alone.
    expect(names).not.toContain('Search for Azcanta');
  });

  it('ranks a name match above a rules-text match for the same term', async () => {
    const r = await request(app).get('/api/search/semantic?q=search');
    const names = r.body.map((c: { name: string }) => c.name);
    // "Search for Azcanta" carries the term in its name; the ramp spells only in oracle text.
    expect(names[0]).toBe('Search for Azcanta');
  });

  it('excludes tokens and short/empty queries', async () => {
    expect((await request(app).get('/api/search/semantic?q=goblin')).body.map((c: { name: string }) => c.name))
      .not.toContain('Goblin Token');
    expect((await request(app).get('/api/search/semantic?q=a')).status).toBe(400);
    // A query of only stop-length words matches nothing rather than everything.
    expect((await request(app).get('/api/search/semantic?q=of to')).body).toEqual([]);
  });

  it('serves the price-mover ticker, empty until a job populates it', async () => {
    const empty = await request(app).get('/api/movers');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    await ctx.pool.query(
      `INSERT INTO price_movers (card_name, previous_price, current_price, percentage_change) VALUES
        ('Sol Ring', 1.00, 1.25, 25), ('Cultivate', 1.00, 0.50, -50), ('Rampant Growth', 1.00, 1.05, 5)`,
    );
    const r = await request(app).get('/api/movers');
    // Ordered by the size of the swing, direction-agnostic.
    expect(r.body.map((m: { card_name: string }) => m.card_name)).toEqual(['Cultivate', 'Sol Ring', 'Rampant Growth']);
  });
});
