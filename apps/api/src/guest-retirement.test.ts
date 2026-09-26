import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const GUEST_PASSWORD = 'guestpass123';

/**
 * Migration 0012, which retires the shared `guest` account left behind by guest mode.
 *
 * Removing `POST /api/auth/guest` does not close anything on its own: legacy's guest row is an
 * ordinary player whose password is the literal `guestpass123`, so it answers the normal login
 * form. The first test here establishes that the hole is real by logging in as the seeded account
 * *before* the migration runs — if that ever stops passing, this whole file is asserting nothing.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/db/migrations');
const MIGRATION_0012 = readFileSync(join(migrationsDir, '0012_retire_guest_account.sql'), 'utf8');

describe.skipIf(!DATABASE_URL || !REDIS_URL)('guest account retirement (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_guest_test_${Date.now()}`;

  async function seedPlayer(id: string, username: string, email: string, password: string) {
    await ctx.pool.query(
      `INSERT INTO players (id, username, store_nickname, email, password_hash, is_admin, role)
       VALUES ($1, $2, $3, $4, $5, 0, 'player')`,
      [id, username, 'Guest Player', email, await bcrypt.hash(password, 10)],
    );
  }

  const login = (username: string, password: string) =>
    request(app).post('/api/auth/login').send({ username, password });

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

    // The row exactly as the SQLite -> Postgres cutover dump would have carried it over.
    await seedPlayer('p_guest_legacy', 'guest', 'guest@grimore.local', GUEST_PASSWORD);
    // A real person who happens to have taken the username, with their own password and email.
    await seedPlayer('p_guest_real', 'guest_real', 'someone@example.com', 'a-real-persons-password');
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('the shared guest account answers the ordinary login form before the migration', async () => {
    // This is the exposure, demonstrated rather than asserted from reading. Anyone who knows the
    // hard-coded string is signed in as a real player — no guest route involved.
    const r = await login('guest', GUEST_PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe('guest');
  });

  it('refuses that password once the migration has run', async () => {
    await ctx.pool.query(MIGRATION_0012);
    const r = await login('guest', GUEST_PASSWORD);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('keeps the row rather than deleting it, so anything it owns survives', async () => {
    const got = await ctx.pool.query('SELECT id, username, email FROM players WHERE id = $1', ['p_guest_legacy']);
    expect(got.rowCount).toBe(1);
    expect(got.rows[0].username).toBe('guest');
  });

  it('leaves a genuine account alone even if it is named guest', async () => {
    // The migration matches on the legacy username *and* email pair, so a real player keeps theirs.
    const r = await login('guest_real', 'a-real-persons-password');
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe('guest_real');
  });

  it('is idempotent — re-running changes nothing', async () => {
    const before = await ctx.pool.query('SELECT password_hash FROM players WHERE id = $1', ['p_guest_legacy']);
    await ctx.pool.query(MIGRATION_0012);
    const after = await ctx.pool.query('SELECT password_hash FROM players WHERE id = $1', ['p_guest_legacy']);
    expect(after.rows[0].password_hash).toBe(before.rows[0].password_hash);
  });

  it('no longer serves the guest route', async () => {
    const r = await request(app).post('/api/auth/guest').send({});
    expect(r.status).toBe(404);
  });
});
