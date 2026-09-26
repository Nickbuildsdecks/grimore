import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';
import type { GoogleIdentity, GoogleVerifier } from './lib/googleIdentity.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

/**
 * Account resolution for Google sign-in, against live Postgres.
 *
 * Verification itself is stubbed here and only here: no test can mint a token Google will sign for
 * a real client id. The real verifier is tested against Google's live endpoints in
 * `googleIdentity.test.ts` — what cannot be faked is checked for real, what cannot be real is
 * faked, and the two files say which is which.
 */
describe.skipIf(!DATABASE_URL || !REDIS_URL)('google sign-in (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_google_test_${Date.now()}`;

  // What the stub will return next, per token string.
  const identities = new Map<string, GoogleIdentity>();
  const stub: GoogleVerifier = {
    async verifyIdToken(credential) {
      return identities.get(`id:${credential}`) ?? null;
    },
    async verifyAccessToken(accessToken) {
      return identities.get(`access:${accessToken}`) ?? null;
    },
  };

  const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
    googleId: 'google-sub-1',
    email: 'player@example.com',
    emailVerified: true,
    name: 'A Player',
    ...over,
  });

  const signIn = (body: Record<string, unknown>) => request(app).post('/api/auth/google').send(body);

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
      GOOGLE_CLIENT_ID: CLIENT_ID,
      ADMIN_GOOGLE_EMAILS: 'owner@example.com',
    });
    ctx = await createContext(env);
    await runMigrations(ctx.pool);
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  beforeEach(async () => {
    identities.clear();
    await ctx.pool.query('DELETE FROM players');
    // A fresh app per test, because `authLimiter` keeps its window in the app instance and allows
    // 20 requests per IP. Sharing one instance across the file would let the suite quietly run out
    // of budget as tests are added, failing on 429 in whichever test happened to be last.
    app = createApp(ctx, { googleVerifier: stub });
  });

  async function seed(id: string, username: string, email: string | null, googleId: string | null = null) {
    await ctx.pool.query(
      `INSERT INTO players (id, username, store_nickname, email, google_id, password_hash, role)
       VALUES ($1, $2, $2, $3, $4, $5, 'player')`,
      [id, username, email, googleId, await bcrypt.hash('some-password', 10)],
    );
  }

  describe('rejection', () => {
    it('requires a credential or an access token', async () => {
      const r = await signIn({});
      expect(r.status).toBe(400);
    });

    it('401s when the token does not verify', async () => {
      const r = await signIn({ credential: 'garbage' });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('gives the same message whatever the failure was', async () => {
      // A prober must not be able to tell "bad signature" from "unverified email" from
      // "not configured" by reading the response.
      const bad = await signIn({ credential: 'garbage' });
      const none = await signIn({ accessToken: 'also-garbage' });
      expect(bad.body.error).toEqual(none.body.error);
    });

    it('never builds an identity from client-supplied fields', async () => {
      // The shape legacy's earlier versions accepted. It must not be a sign-in.
      const r = await signIn({ email: 'owner@example.com', googleId: 'google-sub-1' });
      expect(r.status).toBe(400);
      const count = await ctx.pool.query('SELECT count(*)::int AS n FROM players');
      expect(count.rows[0].n).toBe(0);
    });
  });

  describe('account resolution', () => {
    it('creates an account on first sign-in', async () => {
      identities.set('id:tok', identity());
      const r = await signIn({ credential: 'tok' });
      expect(r.status).toBe(200);
      expect(r.body.user.email).toBe('player@example.com');
      expect(r.body.user.store_nickname).toBe('A Player');
      // Username is derived from the local part plus a numeric suffix.
      expect(r.body.user.username).toMatch(/^player_\d{4}$/);
    });

    it('returns the same account on the second sign-in rather than making another', async () => {
      identities.set('id:tok', identity());
      const first = await signIn({ credential: 'tok' });
      const second = await signIn({ credential: 'tok' });
      expect(second.status).toBe(200);
      expect(second.body.user.id).toBe(first.body.user.id);
      const count = await ctx.pool.query('SELECT count(*)::int AS n FROM players');
      expect(count.rows[0].n).toBe(1);
    });

    it('links to an existing password account with the same email', async () => {
      await seed('p_existing', 'existing_user', 'player@example.com');
      identities.set('id:tok', identity());
      const r = await signIn({ credential: 'tok' });
      expect(r.status).toBe(200);
      expect(r.body.user.id).toBe('p_existing');
      const row = await ctx.pool.query('SELECT google_id FROM players WHERE id = $1', ['p_existing']);
      expect(row.rows[0].google_id).toBe('google-sub-1');
    });

    it('matches an existing email case-insensitively', async () => {
      await seed('p_existing', 'existing_user', 'Player@Example.COM');
      identities.set('id:tok', identity());
      const r = await signIn({ credential: 'tok' });
      expect(r.body.user.id).toBe('p_existing');
    });

    it('accepts the access-token flow as well as the ID-token one', async () => {
      identities.set('access:at', identity({ googleId: 'google-sub-2', email: 'popup@example.com' }));
      const r = await signIn({ accessToken: 'at' });
      expect(r.status).toBe(200);
      expect(r.body.user.email).toBe('popup@example.com');
    });

    it('starts a real session the rest of the API accepts', async () => {
      identities.set('id:tok', identity());
      const agent = request.agent(app);
      const r = await agent.post('/api/auth/google').send({ credential: 'tok' });
      expect(r.status).toBe(200);
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.email).toBe('player@example.com');
    });
  });

  describe('admin allow list', () => {
    it('resolves an allow-listed address to p_admin', async () => {
      await seed('p_admin', 'admin', 'admin@example.com');
      identities.set('id:tok', identity({ email: 'owner@example.com', googleId: 'google-owner' }));
      const r = await signIn({ credential: 'tok' });
      expect(r.status).toBe(200);
      expect(r.body.user.id).toBe('p_admin');
    });

    it('matches the whole address, not a substring of it', async () => {
      await seed('p_admin', 'admin', 'admin@example.com');
      // A prefix/suffix test would let this through as the owner.
      identities.set('id:tok', identity({ email: 'owner@example.com.evil.test', googleId: 'google-evil' }));
      const r = await signIn({ credential: 'tok' });
      expect(r.status).toBe(200);
      expect(r.body.user.id).not.toBe('p_admin');
    });

    it('detaches the google_id from an earlier auto-created account when relinking', async () => {
      // google_id is UNIQUE: without the detach, this UPDATE collides on players_google_id_key.
      await seed('p_admin', 'admin', 'admin@example.com');
      await seed('p_auto', 'owner_1234', 'owner@example.com', 'google-owner');
      identities.set('id:tok', identity({ email: 'owner@example.com', googleId: 'google-owner' }));
      const r = await signIn({ credential: 'tok' });
      expect(r.status).toBe(200);
      expect(r.body.user.id).toBe('p_admin');
      const auto = await ctx.pool.query('SELECT google_id FROM players WHERE id = $1', ['p_auto']);
      expect(auto.rows[0].google_id).toBeNull();
      const admin = await ctx.pool.query('SELECT google_id FROM players WHERE id = $1', ['p_admin']);
      expect(admin.rows[0].google_id).toBe('google-owner');
    });
  });

  describe('status', () => {
    it('reports the configured client id so the SPA can render the button', async () => {
      const r = await request(app).get('/api/auth/status');
      expect(r.status).toBe(200);
      expect(r.body.googleClientId).toBe(CLIENT_ID);
    });
  });
});
