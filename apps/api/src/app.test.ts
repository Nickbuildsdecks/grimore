import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!DATABASE_URL || !REDIS_URL)('api (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_api_test_${Date.now()}`;

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

  it('healthz and readyz respond', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    const r = await request(app).get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ready: true, checks: { db: 'ok', redis: 'ok' } });
  });

  it('unknown routes return the error envelope', async () => {
    const r = await request(app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid registration with field errors', async () => {
    const r = await request(app).post('/api/auth/register').send({ username: 'a', password: 'short' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
    expect(r.body.error.details.username).toBeTruthy();
  });

  it('register → login → me → logout round-trip with a Redis-backed session', async () => {
    const agent = request.agent(app);
    const reg = await agent
      .post('/api/auth/register')
      .send({ username: 'nick_test', password: 'correct-horse-battery', storeNickname: 'Nick', email: 'n@example.com' });
    expect(reg.status).toBe(201);

    const dup = await agent
      .post('/api/auth/register')
      .send({ username: 'NICK_TEST', password: 'correct-horse-battery', storeNickname: 'Nick', email: 'n@example.com' });
    expect(dup.status).toBe(409);

    expect((await agent.get('/api/auth/status')).body.loggedIn).toBe(false);
    expect((await agent.get('/api/auth/me')).status).toBe(401);

    const bad = await agent.post('/api/auth/login').send({ username: 'nick_test', password: 'wrong-password' });
    expect(bad.status).toBe(401);

    const login = await agent.post('/api/auth/login').send({ username: 'nick_test', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('nick_test');
    expect(login.body.user.is_admin).toBe(false);
    expect(login.body.user.premium_status).toBe('free');
    expect(login.headers['set-cookie']?.[0]).toMatch(/grimore\.sid=.*HttpOnly/);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('n@example.com');

    const status = await agent.get('/api/auth/status');
    expect(status.body.loggedIn).toBe(true);

    // Session really lives in Redis
    const keys = await ctx.redis.keys('sess:*');
    expect(keys.length).toBeGreaterThan(0);

    expect((await agent.post('/api/auth/logout')).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('login does not auto-create accounts (audit finding)', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'ghost_user', password: 'whatever-123' });
    expect(r.status).toBe(401);
    const q = await ctx.pool.query('SELECT 1 FROM players WHERE username = $1', ['ghost_user']);
    expect(q.rowCount).toBe(0);
  });
});
