import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

/**
 * The filter's own rules are covered in `packages/shared/src/moderation.test.ts`. What is asserted
 * here is that every write path legacy guarded is still guarded, that the rejection is a 400 the
 * client can act on, and — the regression that motivated the rewrite — that a deck named after a
 * real card gets saved rather than refused.
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('moderation (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_moderation_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let admin: ReturnType<typeof request.agent>;
  let deckId: string;

  async function signup(username: string) {
    const agent = request.agent(app);
    const reg = await agent
      .post('/api/auth/register')
      .send({ username, password: PASSWORD, storeNickname: username, email: `${username}@example.com` });
    expect(reg.status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    expect(login.status).toBe(200);
    return { agent, id: login.body.user.id as string };
  }

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    await adminPool.end();
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

    ({ agent: alice } = await signup('alice_mod'));
    const a = await signup('admin_mod');
    admin = a.agent;
    await ctx.pool.query(`UPDATE players SET is_admin = 1, role = 'admin' WHERE id = $1`, [a.id]);

    const deck = await alice.post('/api/decks/builder-save').send({
      deck_name: 'Starting Deck',
      is_public: true,
      cards: [{ card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 }],
    });
    deckId = deck.body.deckId;
  });

  afterAll(async () => {
    await closeContext(ctx);
    const adminPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await adminPool.query(`DROP DATABASE ${dbName}`);
    await adminPool.end();
  });

  const save = (body: Record<string, unknown>) =>
    alice.post('/api/decks/builder-save').send({
      is_public: true,
      cards: [{ card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 }],
      ...body,
    });

  it('rejects a profane deck name', async () => {
    const r = await save({ deck_name: 'shit deck' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROFANITY');
    expect(r.body.error.message).toContain('Deck name');
  });

  it('never echoes the matched word back to the client', async () => {
    const r = await save({ deck_name: 'shit deck' });
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain('shit');
  });

  it('saves a deck named after a real card that legacy refused', async () => {
    // "Scrap Mastery" contains "crap". Legacy rejected it, so the name was unusable.
    const r = await save({ deck_name: 'Scrap Mastery' });
    expect(r.status).toBe(200);
  });

  it('saves a deck name whose words only spell one across the seam', async () => {
    // Legacy stripped the spaces first, making this "goblinshithard".
    const r = await save({ deck_name: 'Goblins Hit Hard' });
    expect(r.status).toBe(200);
  });

  it('rejects a profane deck tag on save, and on the tags route', async () => {
    const onSave = await save({ deck_name: 'Tag Test', custom_tags: ['budget', 'bitch'] });
    expect(onSave.status).toBe(400);
    expect(onSave.body.error.code).toBe('PROFANITY');

    const onRoute = await alice.post(`/api/decks/${deckId}/tags`).send({ tags: ['fine', 'cunt'] });
    expect(onRoute.status).toBe(400);
    expect(onRoute.body.error.code).toBe('PROFANITY');
  });

  it('rejects a profane per-card tag', async () => {
    const r = await save({
      deck_name: 'Card Tag Test',
      cards: [{ card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5, custom_tag: 'faggot' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Card tags');
  });

  it('rejects a profane deck comment', async () => {
    const r = await alice.post(`/api/decks/${deckId}/comment`).send({ commentText: 'this deck is f*cking bad' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROFANITY');
  });

  it('rejects a profane profile field and names which one', async () => {
    const r = await alice.post('/api/players/profile/update').send({
      storeNickname: 'Scrapheap Scrounger',
      profileBio: 'get bent you asshole',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Bio');
  });

  it('accepts a profile whose fields only look profane', async () => {
    const r = await alice.post('/api/players/profile/update').send({
      storeNickname: 'Scrapheap Scrounger',
      profileBio: 'Dickinson, ND. Goblins Hit Hard.',
    });
    expect(r.status).toBe(200);
    expect(r.body.profile.store_nickname).toBe('Scrapheap Scrounger');
  });

  it('rejects a profane username change before checking whether it is taken', async () => {
    const r = await alice
      .post('/api/players/account/update')
      .send({ currentPassword: PASSWORD, newUsername: 'sh1thead' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROFANITY');
  });

  it('rejects a profane season name', async () => {
    const r = await admin.post('/api/seasons').send({ name: 'the bastard season' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROFANITY');
  });

  it('rejects a profane league name on the rules route', async () => {
    expect((await admin.post('/api/seasons').send({ name: 'Season One' })).status).toBe(201);
    const r = await admin.post('/api/seasons/rules').send({ name: 'crap league' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('PROFANITY');
  });
});
