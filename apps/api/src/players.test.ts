import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('players routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_players_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let aliceId: string;
  let publicDeckId: string;
  let privateDeckId: string;

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

    ({ agent: alice, id: aliceId } = await signup('alice_prof'));
    ({ agent: bob } = await signup('bob_prof'));

    const pub = await alice.post('/api/decks/builder-save').send({
      deck_name: 'Public Deck', is_public: true,
      cards: [{ card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 }],
    });
    publicDeckId = pub.body.deckId;
    const priv = await alice.post('/api/decks/builder-save').send({
      deck_name: 'Secret Brew', is_public: false,
      cards: [{ card_name: 'Thassa, God of the Sea', is_commander: true, cheapest_card_price: 5 }],
    });
    privateDeckId = priv.body.deckId;

    await ctx.pool.query(`INSERT INTO seasons (id, name) VALUES ('s_1', 'Season One')`);
    await ctx.pool.query(
      `INSERT INTO player_stats (player_id, total_games, total_wins, total_kills, total_points, win_rate, season_id)
       VALUES ($1, 10, 4, 7, 22, 0.4, 's_1')`,
      [aliceId],
    );
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('404s an unknown player', async () => {
    const r = await request(app).get('/api/players/p_nope/profile');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('serves a public profile without the email, and with stats joined to the season', async () => {
    const r = await request(app).get(`/api/players/${aliceId}/profile`);
    expect(r.status).toBe(200);
    expect(r.body.profile.store_nickname).toBe('alice_prof');
    expect(r.body.isOwner).toBe(false);
    // PII must not leak to an anonymous visitor.
    expect(r.body.profile.email).toBeUndefined();
    // The columns migration 0006 added; legacy raised here because they did not exist.
    expect(r.body.profile.profile_theme).toBe('default');
    expect(r.body.profile.featured_deck_id).toBeNull();
    expect(r.body.profile.discord_handle).toBeNull();
    expect(r.body.stats).toHaveLength(1);
    expect(r.body.stats[0].total_wins).toBe(4);
    expect(r.body.stats[0].season_name).toBe('Season One');
  });

  it('shows only public decks to a visitor, and all decks to the owner', async () => {
    const visitor = await request(app).get(`/api/players/${aliceId}/profile`);
    expect(visitor.body.publicDecks.map((d: { deck_name: string }) => d.deck_name)).toEqual(['Public Deck']);

    const own = await alice.get(`/api/players/${aliceId}/profile`);
    expect(own.body.isOwner).toBe(true);
    expect(own.body.profile.email).toBe('alice_prof@example.com');
    expect(own.body.publicDecks.map((d: { deck_name: string }) => d.deck_name).sort()).toEqual(['Public Deck', 'Secret Brew']);
  });

  it('keeps a stats row whose season_id is NULL (legacy inner-joined it away)', async () => {
    const { id } = await signup('carol_prof');
    await ctx.pool.query(`INSERT INTO player_stats (player_id, total_games, season_id) VALUES ($1, 3, NULL)`, [id]);
    const r = await request(app).get(`/api/players/${id}/profile`);
    expect(r.body.stats).toHaveLength(1);
    expect(r.body.stats[0].total_games).toBe(3);
    expect(r.body.stats[0].season_name).toBeNull();
  });

  it('requires a session to edit a profile or account', async () => {
    const anon = request(app);
    expect((await anon.post('/api/players/profile/update').send({ storeNickname: 'x' })).status).toBe(401);
    expect((await anon.post('/api/players/account/update').send({ currentPassword: PASSWORD, newEmail: 'a@b.com' })).status).toBe(401);
  });

  it('updates the profile and rejects an empty nickname', async () => {
    const r = await alice.post('/api/players/profile/update').send({
      storeNickname: 'Alice the Brewer',
      profileBio: '  Commander only.  ',
      discordHandle: 'alice#1234',
      moxfieldUsername: 'alicebrews',
      profileTheme: 'midnight',
    });
    expect(r.status).toBe(200);
    expect(r.body.profile.store_nickname).toBe('Alice the Brewer');
    expect(r.body.profile.profile_bio).toBe('Commander only.'); // trimmed
    expect(r.body.profile.discord_handle).toBe('alice#1234');
    expect(r.body.profile.profile_theme).toBe('midnight');

    expect((await alice.post('/api/players/profile/update').send({ storeNickname: '   ' })).status).toBe(400);
  });

  it('normalizes an empty optional field to NULL rather than an empty string', async () => {
    const r = await alice.post('/api/players/profile/update').send({ storeNickname: 'Alice the Brewer', discordHandle: '' });
    expect(r.status).toBe(200);
    expect(r.body.profile.discord_handle).toBeNull();
  });

  it("refuses to feature another player's deck", async () => {
    const r = await bob.post('/api/players/profile/update').send({ storeNickname: 'Bob', featuredDeckId: publicDeckId });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/does not belong to you/);
  });

  it('serves a featured public deck, and hides a featured private one from visitors', async () => {
    await alice.post('/api/players/profile/update').send({ storeNickname: 'Alice the Brewer', featuredDeckId: publicDeckId });
    const visitor = await request(app).get(`/api/players/${aliceId}/profile`);
    expect(visitor.body.featuredDeck.deck_name).toBe('Public Deck');
    expect(visitor.body.featuredDeck.commander_name).toBe('Krenko, Mob Boss');

    // Featuring a PRIVATE deck must not publish it. Legacy selected it with no visibility check.
    await alice.post('/api/players/profile/update').send({ storeNickname: 'Alice the Brewer', featuredDeckId: privateDeckId });
    const hidden = await request(app).get(`/api/players/${aliceId}/profile`);
    expect(hidden.body.profile.featured_deck_id).toBe(privateDeckId);
    expect(hidden.body.featuredDeck).toBeNull();
    // The owner still sees it.
    expect((await alice.get(`/api/players/${aliceId}/profile`)).body.featuredDeck.deck_name).toBe('Secret Brew');
  });

  it('clears featured_deck_id when the deck is deleted instead of dangling', async () => {
    const { agent, id } = await signup('dave_prof');
    const deck = await agent.post('/api/decks/builder-save').send({ deck_name: 'Temp', cards: [{ card_name: 'Sol Ring' }] });
    await agent.post('/api/players/profile/update').send({ storeNickname: 'Dave', featuredDeckId: deck.body.deckId });
    expect((await agent.delete(`/api/decks/${deck.body.deckId}`)).status).toBe(200);
    const r = await agent.get(`/api/players/${id}/profile`);
    expect(r.body.profile.featured_deck_id).toBeNull();
    expect(r.body.featuredDeck).toBeNull();
  });

  it('requires the current password for ANY credential change, not just a password one', async () => {
    // Legacy let a hijacked session change the username and email with no password at all.
    const noPassword = await alice.post('/api/players/account/update').send({ newEmail: 'attacker@example.com' });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error.code).toBe('VALIDATION');

    const wrongPassword = await alice
      .post('/api/players/account/update')
      .send({ currentPassword: 'not-my-password', newEmail: 'attacker@example.com' });
    expect(wrongPassword.status).toBe(403);

    const unchanged = await ctx.pool.query('SELECT email FROM players WHERE id = $1', [aliceId]);
    expect(unchanged.rows[0].email).toBe('alice_prof@example.com');
  });

  it('rejects a change set that changes nothing, and a malformed email', async () => {
    expect((await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD })).status).toBe(400);
    expect(
      (await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD, newEmail: 'not-an-email' })).status,
    ).toBe(400);
  });

  it('409s a taken username, case-insensitively (legacy compared exactly and 400d)', async () => {
    const r = await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD, newUsername: 'BOB_PROF' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('USERNAME_TAKEN');
    const still = await ctx.pool.query('SELECT username FROM players WHERE id = $1', [aliceId]);
    expect(still.rows[0].username).toBe('alice_prof');
  });

  it('409s a taken email', async () => {
    const r = await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD, newEmail: 'bob_prof@example.com' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('changes the username, storing it lowercased so one login maps to one account', async () => {
    const r = await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD, newUsername: 'AliceBrews' });
    expect(r.status).toBe(200);
    const row = await ctx.pool.query('SELECT username FROM players WHERE id = $1', [aliceId]);
    expect(row.rows[0].username).toBe('alicebrews');
    // The new name logs in from a fresh agent, in any case.
    const fresh = request.agent(app);
    expect((await fresh.post('/api/auth/login').send({ username: 'ALICEBREWS', password: PASSWORD })).status).toBe(200);
  });

  it('changes the password and keeps the caller signed in on a fresh session id', async () => {
    const newPassword = 'a-brand-new-passphrase';
    const r = await alice.post('/api/players/account/update').send({ currentPassword: PASSWORD, newPassword });
    expect(r.status).toBe(200);
    // The caller's own session survives, re-issued under a new id.
    expect((await alice.get('/api/auth/me')).status).toBe(200);

    const fresh = request.agent(app);
    expect((await fresh.post('/api/auth/login').send({ username: 'alicebrews', password: PASSWORD })).status).toBe(401);
    expect((await fresh.post('/api/auth/login').send({ username: 'alicebrews', password: newPassword })).status).toBe(200);
  });

  it('rejects a new password that fails the policy', async () => {
    const r = await bob.post('/api/players/account/update').send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });
});
