/**
 * Does changing a password actually end the attacker's session?
 *
 * `players.ts` asserts it does: "A password change invalidates other sessions by rotating this one's
 * id; a session stolen before the change no longer resolves." That describes
 * `req.session.regenerate()`, which destroys and reissues the CALLER's session. A session someone else
 * holds is a different key in the store and is untouched by it.
 *
 * The canonical reason a person resets their password is that someone else is in their account, so this
 * is the one property the flow exists to provide. ASVS requires terminating all other active sessions
 * on credential change.
 *
 * Two agents, two real sessions, one password change. The second agent must be logged out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-different-long-passphrase';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('session invalidation on credential change', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_epoch_test_${Date.now()}`;

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
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  /** A signed-in agent with its own session, as a separate browser or a thief's would be. */
  async function signIn(username: string, password = PASSWORD) {
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);
    return agent;
  }

  it('signs out a session held elsewhere when the password changes', async () => {
    const owner = request.agent(app);
    const reg = await owner
      .post('/api/auth/register')
      .send({ username: 'epoch_victim', password: PASSWORD, storeNickname: 'Victim', email: 'epoch@example.com' });
    expect(reg.status).toBe(201);
    await owner.post('/api/auth/login').send({ username: 'epoch_victim', password: PASSWORD });

    // A second, independent session on the same account — what a stolen cookie is.
    const elsewhere = await signIn('epoch_victim');
    expect((await elsewhere.get('/api/auth/status')).body.loggedIn).toBe(true);

    const changed = await owner
      .post('/api/players/account/update')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);

    // The owner keeps their session, by design.
    expect((await owner.get('/api/auth/status')).body.loggedIn).toBe(true);

    // The other session must be gone. Rotating the caller's own session id does nothing to this one.
    const after = await elsewhere.get('/api/auth/status');
    // 200 with loggedIn:false, not a 500. The guard regenerates rather than destroying precisely
    // because express-session nulls `req.session` on destroy and the handlers read it unguarded.
    expect(after.status).toBe(200);
    expect(after.body.loggedIn).toBe(false);
  });

  it('leaves sessions on other accounts alone', async () => {
    const victim = request.agent(app);
    await victim
      .post('/api/auth/register')
      .send({ username: 'epoch_a', password: PASSWORD, storeNickname: 'A', email: 'epoch_a@example.com' });
    await victim.post('/api/auth/login').send({ username: 'epoch_a', password: PASSWORD });

    const bystander = request.agent(app);
    await bystander
      .post('/api/auth/register')
      .send({ username: 'epoch_b', password: PASSWORD, storeNickname: 'B', email: 'epoch_b@example.com' });
    await bystander.post('/api/auth/login').send({ username: 'epoch_b', password: PASSWORD });

    await victim.post('/api/players/account/update').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    // The mark is per player. A blunt implementation that bumped a global epoch would sign out the
    // whole site on every password change.
    expect((await bystander.get('/api/auth/status')).body.loggedIn).toBe(true);
  });

  it('refuses a session carrying no epoch at all', async () => {
    // Every session open at deploy time is in this state. Trusting them would mean an indefinite
    // bypass of the check for exactly the sessions nobody can account for, so they are invalid and
    // cost one re-login.
    const agent = request.agent(app);
    const registered = await agent
      .post('/api/auth/register')
      .send({ username: 'epoch_old', password: PASSWORD, storeNickname: 'Old', email: 'epoch_old@example.com' });
    const loggedIn = await agent.post('/api/auth/login').send({ username: 'epoch_old', password: PASSWORD });
    expect((await agent.get('/api/auth/status')).body.loggedIn).toBe(true);

    // The login may or may not rotate the cookie, so take whichever response last set one.
    const sessionId =
      sessionIdFromCookies(loggedIn.headers['set-cookie']) ??
      sessionIdFromCookies(registered.headers['set-cookie']);
    expect(sessionId).not.toBeNull();

    // Strip the stamp the way a pre-deploy session would have been stored, leaving playerId intact.
    const sid = await stripEpochFromStoredSession(ctx, sessionId);
    expect(sid).not.toBeNull();

    expect((await agent.get('/api/auth/status')).body.loggedIn).toBe(false);
  });

  it('fails closed when the epoch cannot be read, rather than letting the request through', async () => {
    const agent = request.agent(app);
    await agent
      .post('/api/auth/register')
      .send({ username: 'epoch_closed', password: PASSWORD, storeNickname: 'C', email: 'epoch_c@example.com' });
    await agent.post('/api/auth/login').send({ username: 'epoch_closed', password: PASSWORD });

    // Break the lookup the guard depends on. Passing the request through on a database error would make
    // the whole check bypassable by anything that can make this query fail.
    await ctx.pool.query('ALTER TABLE players RENAME COLUMN sessions_valid_from TO sessions_valid_from_moved');
    try {
      const r = await agent.get('/api/auth/status');
      expect(r.status).toBe(500);
      expect(r.body.loggedIn).toBeUndefined();
    } finally {
      await ctx.pool.query('ALTER TABLE players RENAME COLUMN sessions_valid_from_moved TO sessions_valid_from');
    }
  });
});

/**
 * The session id from a `set-cookie` header. express-session signs the cookie as `s:<id>.<sig>`.
 */
function sessionIdFromCookies(setCookie: string | string[] | undefined): string | null {
  const headers = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    const match = /(?:^|;\s*)grimore\.sid=([^;]+)/.exec(header);
    if (!match) continue;
    const value = decodeURIComponent(match[1]!);
    const unsigned = value.startsWith('s:') ? value.slice(2) : value;
    const id = unsigned.split('.')[0];
    if (id) return id;
  }
  return null;
}

/**
 * Remove the `epoch` key from a stored session, leaving `playerId`, to reproduce a session issued
 * before this code existed. Reaches into the Redis session record because that is the only place
 * the shape of a stored session can be altered from outside a request.
 *
 * Keyed directly off the session id from the cookie rather than found by scanning.
 * It used to `SCAN` the whole keyspace for `*sess*` and match on playerId, which failed
 * intermittently in the full workspace run and never alone: every suite shares one Redis, and SCAN
 * makes no promise about keys added or removed while it iterates, so under concurrent churn it
 * could simply not return the key this test had just created. A lookup by exact key cannot miss.
 */
async function stripEpochFromStoredSession(ctx: AppContext, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const key = `sess:${sessionId}`;
  const raw = await ctx.redis.get(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { playerId?: string; epoch?: number };
  delete parsed.epoch;
  await ctx.redis.set(key, JSON.stringify(parsed));
  return key;
}
