import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('social routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_social_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let carol: ReturnType<typeof request.agent>;
  let aliceId: string;
  let bobId: string;
  let carolId: string;

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

  const notificationsFor = async (playerId: string) =>
    (await ctx.pool.query('SELECT type, title, message, is_read FROM notifications WHERE player_id = $1 ORDER BY id', [playerId])).rows;

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
    ({ agent: alice, id: aliceId } = await signup('alice_soc'));
    ({ agent: bob, id: bobId } = await signup('bob_soc'));
    ({ agent: carol, id: carolId } = await signup('carol_soc'));
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('rejects every social route without a session', async () => {
    const anon = request(app);
    for (const r of [
      anon.get('/api/friends'),
      anon.get('/api/friends/requests'),
      anon.get('/api/friends/status/p_1'),
      anon.post('/api/friends/request/p_1'),
      anon.post('/api/friends/accept/fr_1'),
      anon.post('/api/friends/decline/fr_1'),
      anon.delete('/api/friends/p_1'),
      anon.get('/api/messages/inbox'),
      anon.get('/api/messages/sent'),
      anon.get('/api/messages/unread-count'),
      anon.post('/api/messages/send').send({ recipientUsername: 'bob_soc', body: 'hi' }),
      anon.post('/api/messages/feedback').send({ body: 'hi' }),
      anon.post('/api/messages/msg_1/read'),
      anon.get('/api/notifications'),
      anon.post('/api/notifications/read').send({ all: true }),
      anon.post('/api/players/p_1/follow'),
    ]) {
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  // ── Friends ─────────────────────────────────────────────────────────────────────────────────────

  let requestId: string;

  it('sends a friend request and notifies the recipient in the same write', async () => {
    expect((await alice.get(`/api/friends/status/${bobId}`)).body.status).toBe('none');
    const r = await alice.post(`/api/friends/request/${bobId}`);
    expect(r.status).toBe(201);
    requestId = r.body.requestId;

    const notifs = await notificationsFor(bobId);
    expect(notifs).toHaveLength(1);
    // notifications.type is NOT NULL and every legacy INSERT omitted it.
    expect(notifs[0].type).toBe('friend_request');
    expect(notifs[0].title).toBe('Friend request from alice_soc');

    const status = await alice.get(`/api/friends/status/${bobId}`);
    expect(status.body).toMatchObject({ status: 'pending', isSender: true, requestId });
    // The other side sees the same request from their perspective.
    expect((await bob.get(`/api/friends/status/${aliceId}`)).body).toMatchObject({ status: 'pending', isSender: false });
  });

  it('refuses self-friending, an unknown player, and a duplicate request in either direction', async () => {
    expect((await alice.post(`/api/friends/request/${aliceId}`)).status).toBe(400);
    expect((await alice.post('/api/friends/request/p_nobody')).status).toBe(404);
    expect((await alice.post(`/api/friends/request/${bobId}`)).status).toBe(409);
    // The reverse direction is the same friendship; legacy allowed a second row here.
    const reverse = await bob.post(`/api/friends/request/${aliceId}`);
    expect(reverse.status).toBe(409);
    const rows = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM friend_requests');
    expect(rows.rows[0].n).toBe(1);
  });

  it('lists the pending request for its recipient only', async () => {
    const forBob = await bob.get('/api/friends/requests');
    expect(forBob.body).toHaveLength(1);
    expect(forBob.body[0].sender_username).toBe('alice_soc');
    expect((await alice.get('/api/friends/requests')).body).toEqual([]);
  });

  it('only the recipient can accept, and accepting notifies the sender', async () => {
    expect((await carol.post(`/api/friends/accept/${requestId}`)).status).toBe(404);
    expect((await alice.post(`/api/friends/accept/${requestId}`)).status).toBe(404);

    const r = await bob.post(`/api/friends/accept/${requestId}`);
    expect(r.status).toBe(200);
    const notifs = await notificationsFor(aliceId);
    expect(notifs.at(-1).type).toBe('friend_accepted');
    expect(notifs.at(-1).title).toBe('bob_soc accepted your friend request');
  });

  it('refuses to accept an already-answered request (legacy re-notified every time)', async () => {
    const again = await bob.post(`/api/friends/accept/${requestId}`);
    expect(again.status).toBe(409);
    const notifs = await notificationsFor(aliceId);
    expect(notifs.filter((n) => n.type === 'friend_accepted')).toHaveLength(1);
  });

  it('shows the friendship from both sides', async () => {
    const forAlice = await alice.get('/api/friends');
    expect(forAlice.body).toHaveLength(1);
    expect(forAlice.body[0].friend_id).toBe(bobId);
    expect(forAlice.body[0].friend_username).toBe('bob_soc');

    const forBob = await bob.get('/api/friends');
    expect(forBob.body[0].friend_id).toBe(aliceId);
    expect((await carol.get('/api/friends')).body).toEqual([]);
  });

  it('lets a declined pair try again (legacy blocked them forever)', async () => {
    const first = await alice.post(`/api/friends/request/${carolId}`);
    expect(first.status).toBe(201);
    expect((await carol.post(`/api/friends/decline/${first.body.requestId}`)).status).toBe(200);
    // Legacy left a status='declined' row that its own duplicate guard then matched permanently.
    expect((await carol.get(`/api/friends/status/${aliceId}`)).body.status).toBe('none');
    const second = await carol.post(`/api/friends/request/${aliceId}`);
    expect(second.status).toBe(201);
    expect((await alice.post(`/api/friends/accept/${second.body.requestId}`)).status).toBe(200);
    expect((await alice.get('/api/friends')).body).toHaveLength(2);
  });

  it('unfriends, and reports a friendship that was not there', async () => {
    expect((await alice.delete(`/api/friends/${carolId}`)).status).toBe(200);
    expect((await alice.get(`/api/friends/status/${carolId}`)).body.status).toBe('none');
    // Legacy reported success whether or not a friendship existed.
    expect((await alice.delete(`/api/friends/${carolId}`)).status).toBe(404);
  });

  // ── Messages ────────────────────────────────────────────────────────────────────────────────────

  let messageId: string;

  it('sends a message, storing it in `messages` and notifying in the same transaction', async () => {
    const r = await alice.post('/api/messages/send').send({ recipientUsername: 'BOB_SOC', subject: 'Trade?', body: '  Want to trade a Sol Ring?  ' });
    expect(r.status).toBe(201);
    messageId = r.body.messageId;
    expect(messageId).toMatch(/^msg_/);

    // Legacy queried `direct_messages`, which does not exist in this schema.
    const row = await ctx.pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
    expect(row.rows[0].recipient_id).toBe(bobId);
    expect(row.rows[0].body).toBe('Want to trade a Sol Ring?'); // trimmed
    expect(row.rows[0].is_read).toBe(0);

    const notifs = await notificationsFor(bobId);
    expect(notifs.at(-1).type).toBe('message');
    expect(notifs.at(-1).message).toContain('Trade?');
  });

  it('defaults a missing subject and rejects an empty body', async () => {
    const r = await alice.post('/api/messages/send').send({ recipientUsername: 'bob_soc', body: 'no subject here' });
    expect(r.status).toBe(201);
    const row = await ctx.pool.query('SELECT subject FROM messages WHERE id = $1', [r.body.messageId]);
    expect(row.rows[0].subject).toBe('(no subject)');
    expect((await alice.post('/api/messages/send').send({ recipientUsername: 'bob_soc', body: '   ' })).status).toBe(400);
  });

  it('404s an unknown recipient and refuses self-messaging', async () => {
    expect((await alice.post('/api/messages/send').send({ recipientUsername: 'ghost_user', body: 'hi' })).status).toBe(404);
    expect((await alice.post('/api/messages/send').send({ recipientUsername: 'alice_soc', body: 'hi' })).status).toBe(400);
  });

  it('lists inbox and sent from each side, with the counterpart resolved', async () => {
    const inbox = await bob.get('/api/messages/inbox');
    expect(inbox.body).toHaveLength(2);
    expect(inbox.body[0].counterpart_username).toBe('alice_soc');

    const sent = await alice.get('/api/messages/sent');
    expect(sent.body).toHaveLength(2);
    expect(sent.body[0].counterpart_username).toBe('bob_soc');
    expect((await alice.get('/api/messages/inbox')).body).toEqual([]);
  });

  it('counts and clears unread messages', async () => {
    expect((await bob.get('/api/messages/unread-count')).body.count).toBe(2);
    expect((await bob.post(`/api/messages/${messageId}/read`)).status).toBe(200);
    expect((await bob.get('/api/messages/unread-count')).body.count).toBe(1);
  });

  it("404s marking someone else's message read (legacy reported success)", async () => {
    expect((await carol.post(`/api/messages/${messageId}/read`)).status).toBe(404);
    expect((await alice.post(`/api/messages/${messageId}/read`)).status).toBe(404);
  });

  it('routes feedback to the administrator', async () => {
    // No admin exists yet, so the route says so rather than 500ing.
    expect((await alice.post('/api/messages/feedback').send({ body: 'Great app' })).status).toBe(503);

    await ctx.pool.query('UPDATE players SET is_admin = 1 WHERE id = $1', [carolId]);
    const r = await alice.post('/api/messages/feedback').send({ body: 'Great app' });
    expect(r.status).toBe(201);
    const inbox = await carol.get('/api/messages/inbox');
    expect(inbox.body[0].subject).toBe('Feedback from alice_soc');
    expect((await notificationsFor(carolId)).at(-1).type).toBe('feedback');
    // The admin does not file feedback with themselves.
    expect((await carol.post('/api/messages/feedback').send({ body: 'self' })).status).toBe(400);
  });

  it('builds notification text from the database, not a stale session copy', async () => {
    await alice.post('/api/players/profile/update').send({ storeNickname: 'Alice Renamed' });
    const r = await alice.post('/api/messages/send').send({ recipientUsername: 'bob_soc', body: 'after rename' });
    expect(r.status).toBe(201);
    // Legacy read req.session.player.storeNickname, which still held the old name.
    expect((await notificationsFor(bobId)).at(-1).title).toBe('Message from Alice Renamed');
  });

  // ── Notifications ───────────────────────────────────────────────────────────────────────────────

  it('lists notifications with an unread count, and honours limit and unreadOnly', async () => {
    const r = await bob.get('/api/notifications');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(1);
    expect(r.body.unreadCount).toBe(r.body.items.length);
    // Legacy hard-coded LIMIT 10 with no way to ask for anything else.
    expect((await bob.get('/api/notifications?limit=1')).body.items).toHaveLength(1);
    expect((await bob.get('/api/notifications?unreadOnly=true')).body.items.length).toBe(r.body.unreadCount);
  });

  it('marks one notification read, and 404s another player\'s', async () => {
    const list = await bob.get('/api/notifications');
    const id = list.body.items[0].id;
    expect(typeof id).toBe('number'); // the serial from the schema, not a text id
    expect((await bob.post('/api/notifications/read').send({ id })).status).toBe(200);
    expect((await bob.get('/api/notifications')).body.unreadCount).toBe(list.body.unreadCount - 1);
    expect((await carol.post('/api/notifications/read').send({ id })).status).toBe(404);
    expect((await bob.post('/api/notifications/read').send({})).status).toBe(400);
  });

  it('marks every notification read at once', async () => {
    const r = await bob.post('/api/notifications/read').send({ all: true });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBeGreaterThan(0);
    expect((await bob.get('/api/notifications')).body.unreadCount).toBe(0);
    expect((await bob.get('/api/notifications?unreadOnly=true')).body.items).toEqual([]);
  });

  // ── Follows ─────────────────────────────────────────────────────────────────────────────────────

  it('toggles a follow and notifies the followed player', async () => {
    const on = await alice.post(`/api/players/${carolId}/follow`);
    expect(on.status).toBe(200);
    expect(on.body.following).toBe(true);
    // The legacy query named `followed_id`; the column is `following_id`.
    const row = await ctx.pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [aliceId, carolId]);
    expect(row.rowCount).toBe(1);
    expect((await notificationsFor(carolId)).at(-1).type).toBe('follow');

    const off = await alice.post(`/api/players/${carolId}/follow`);
    expect(off.body.following).toBe(false);
    expect((await ctx.pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [aliceId, carolId])).rowCount).toBe(0);
  });

  it('never stores the same follow twice', async () => {
    await alice.post(`/api/players/${bobId}/follow`);
    await ctx.pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [aliceId, bobId]);
    const rows = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM follows WHERE follower_id = $1 AND following_id = $2', [aliceId, bobId]);
    expect(rows.rows[0].n).toBe(1);
    // One click is enough to undo it.
    expect((await alice.post(`/api/players/${bobId}/follow`)).body.following).toBe(false);
  });

  it('reports follow state with a follower count, and stays quiet for anonymous callers', async () => {
    await bob.post(`/api/players/${carolId}/follow`);
    const r = await bob.get(`/api/players/${carolId}/following`);
    expect(r.body).toEqual({ following: true, followerCount: 1 });
    expect((await alice.get(`/api/players/${carolId}/following`)).body.following).toBe(false);
    expect((await request(app).get(`/api/players/${carolId}/following`)).body).toEqual({ following: false, followerCount: 0 });
  });

  it('refuses self-following and an unknown target', async () => {
    expect((await alice.post(`/api/players/${aliceId}/follow`)).status).toBe(400);
    expect((await alice.post('/api/players/p_nobody/follow')).status).toBe(404);
  });
});
