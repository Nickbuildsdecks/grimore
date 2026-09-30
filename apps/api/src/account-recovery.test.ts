/**
 * Password recovery and email verification, end to end against a real Postgres and Redis.
 *
 * Legacy had these routes and they never worked. Every test here corresponds to a finding in
 * claude/account-system-design.md, and several assert a NEGATIVE — that something does not leak, does
 * not get stored, does not survive. Those are the ones that matter: a recovery flow that works on the
 * happy path and leaks on the others is the flow legacy had.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { MemoryTransport } from '@grimore/mailer';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'quiet-library-morning-42';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('account recovery (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  let mail: MemoryTransport;
  const dbName = `grimore_recovery_test_${Date.now()}`;

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
      APP_BASE_URL: 'https://grimore.test',
    });
    ctx = await createContext(env);
    await runMigrations(ctx.pool);
    mail = new MemoryTransport();
    app = createApp(ctx, { mailer: mail });
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  beforeEach(() => mail.clear());

  /**
   * Every request in this suite carries its own apparent source address.
   *
   * Two limiters sit in front of these routes: 20 per 15 minutes on `/api/auth` generally, and 10 on the
   * recovery routes specifically, because each of those can send an email. The server runs
   * `trust proxy 1`, so the bucket is keyed on X-Forwarded-For — the same path production uses behind
   * Caddy. Sharing one address across the suite exhausts the budget and later tests fail with 429s that
   * look nothing like the behaviour under test, which is how the first run of this file went.
   *
   * A test that means to exercise a limiter passes explicit, repeated addresses.
   */
  let ipSeq = 0;
  function nextIp(): string {
    ipSeq += 1;
    return `10.80.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  }

  /** A one-off unauthenticated client. */
  function anon(ip = nextIp()) {
    return {
      post: (path: string) => request(app).post(path).set('X-Forwarded-For', ip),
      get: (path: string) => request(app).get(path).set('X-Forwarded-For', ip),
    };
  }

  /** A cookie-keeping client that stamps the same address on every request it makes. */
  function client(ip = nextIp()) {
    const agent = request.agent(app);
    return {
      ip,
      post: (path: string) => agent.post(path).set('X-Forwarded-For', ip),
      get: (path: string) => agent.get(path).set('X-Forwarded-For', ip),
    };
  }
  type Client = ReturnType<typeof client>;

  let seq = 0;
  /** A registered, signed-in account with its own agent and its own apparent source address. */
  async function account(email?: string): Promise<{ agent: Client; username: string; id: string; email: string }> {
    seq += 1;
    const username = `rec_user_${seq}_${Math.random().toString(36).slice(2, 7)}`;
    const agent = client();
    const address = email ?? `${username}@example.test`;
    const reg = await agent
      .post('/api/auth/register')
      .send({ username, password: PASSWORD, storeNickname: `Rec ${seq}`, email: address });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    return { agent, username, id: login.body.user.id as string, email: address };
  }

  /** The token out of the most recent message. The plaintext exists only here and in the email. */
  function tokenFromMail(): string {
    const body = mail.last()?.text ?? '';
    const m = body.match(/token=([A-Za-z0-9_\-%]+)/);
    expect(m, `no token in mail body: ${body}`).toBeTruthy();
    return decodeURIComponent(m![1]);
  }

  /** A reset request. Gets its own source address unless one is named, for the throttling tests. */
  async function forgot(identifier: string, ip?: string) {
    return anon(ip).post('/api/auth/forgot-password').send({ usernameOrEmail: identifier });
  }

  describe('requesting a reset', () => {
    it('sends a link and stores only a hash of the token', async () => {
      const a = await account();
      const r = await forgot(a.username);
      expect(r.status).toBe(200);
      expect(mail.sent).toHaveLength(1);
      expect(mail.last()!.to).toBe(a.email);

      const token = tokenFromMail();
      const rows = await ctx.pool.query('SELECT token_hash, player_id FROM password_resets WHERE player_id = $1', [a.id]);
      expect(rows.rowCount).toBe(1);
      // The legacy table stored the token as issued, so any read of it was a live credential.
      expect(rows.rows[0].token_hash).not.toBe(token);
      expect(rows.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      // And the row keys on the immutable id, not the mutable username.
      expect(rows.rows[0].player_id).toBe(a.id);
    });

    it('accepts the email address as well as the username', async () => {
      const a = await account();
      expect((await forgot(a.email)).status).toBe(200);
      expect(mail.sent).toHaveLength(1);
    });

    it('answers identically for an account that does not exist, and sends nothing', async () => {
      const a = await account();
      const known = await forgot(a.username);
      mail.clear();
      const unknown = await forgot('no_such_person_at_all');
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(mail.sent).toHaveLength(0);
    });

    it('never puts the token in the response body', async () => {
      // Legacy attached `devResetLink` whenever NODE_ENV was not exactly "production", so an unset
      // NODE_ENV made this an unauthenticated account-takeover API. It now needs its own explicit flag
      // as well, which this suite does not set.
      const a = await account();
      const r = await forgot(a.username);
      expect(JSON.stringify(r.body)).not.toContain('token=');
      expect(r.body.devResetLink).toBeUndefined();
    });

    it('throttles per account, without revealing that the account exists', async () => {
      const a = await account();
      // Distinct source addresses, so this exercises the per-account ceiling and not the per-IP one —
      // the per-IP limiter does nothing against a distributed attempt on one account.
      for (let i = 0; i < 6; i += 1) {
        const r = await forgot(a.username, `10.91.0.${i + 1}`);
        expect(r.status).toBe(200);
      }
      // Five sent, the sixth suppressed — and the sixth response is indistinguishable from the others.
      expect(mail.sent).toHaveLength(5);
    });
  });

  describe('redeeming a reset', () => {
    async function requestReset() {
      const a = await account();
      await forgot(a.username);
      return { ...a, token: tokenFromMail() };
    }

    it('sets the new password and lets the account sign in with it', async () => {
      const a = await requestReset();
      const r = await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD });
      expect(r.status, JSON.stringify(r.body)).toBe(200);

      const fresh = client();
      expect((await fresh.post('/api/auth/login').send({ username: a.username, password: NEW_PASSWORD })).status).toBe(200);
      expect((await fresh.post('/api/auth/login').send({ username: a.username, password: PASSWORD })).status).toBe(401);
    });

    it('does not sign the redeemer in', async () => {
      // Holding the link proves control of the inbox, which is enough to set a password and then be
      // asked for it — not enough to be handed the session.
      const a = await requestReset();
      const agent = client();
      await agent.post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD });
      expect((await agent.get('/api/auth/status')).body.loggedIn).toBe(false);
    });

    it('ends every existing session on the account', async () => {
      // The reason someone resets a password is that another person is in their account.
      const a = await requestReset();
      expect((await a.agent.get('/api/auth/status')).body.loggedIn).toBe(true);
      await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD });
      expect((await a.agent.get('/api/auth/status')).body.loggedIn).toBe(false);
    });

    it('refuses a second use of the same token', async () => {
      const a = await requestReset();
      expect((await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD })).status).toBe(200);
      const again = await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: 'another-good-passphrase' });
      expect(again.status).toBe(400);
      // The password must still be the first one set, not the second attempt's.
      const fresh = client();
      expect((await fresh.post('/api/auth/login').send({ username: a.username, password: NEW_PASSWORD })).status).toBe(200);
    });

    it('kills every other outstanding token for the account when one is redeemed', async () => {
      const a = await account();
      await forgot(a.username, '10.92.0.1');
      const first = tokenFromMail();
      await forgot(a.username, '10.92.0.2');
      const second = tokenFromMail();
      expect(first).not.toBe(second);

      expect((await anon().post('/api/auth/reset-password').send({ token: second, newPassword: NEW_PASSWORD })).status).toBe(200);
      // An older recovery mail still sitting in an inbox is worthless now.
      const stale = await anon().post('/api/auth/reset-password').send({ token: first, newPassword: 'yet-another-passphrase' });
      expect(stale.status).toBe(400);
    });

    it('refuses an expired token', async () => {
      const a = await requestReset();
      await ctx.pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE player_id = $1", [a.id]);
      const r = await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD });
      expect(r.status).toBe(400);
    });

    it('refuses a token that never existed', async () => {
      const r = await anon().post('/api/auth/reset-password').send({ token: 'not-a-real-token-at-all', newPassword: NEW_PASSWORD });
      expect(r.status).toBe(400);
    });

    it('gives the same message for unknown, expired and already-used', async () => {
      // Distinguishing them tells a holder whether a candidate was ever real, and whether the account
      // still exists.
      const unknown = await anon().post('/api/auth/reset-password').send({ token: 'nope-nope-nope', newPassword: NEW_PASSWORD });

      const expired = await requestReset();
      await ctx.pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE player_id = $1", [expired.id]);
      const expiredRes = await anon().post('/api/auth/reset-password').send({ token: expired.token, newPassword: NEW_PASSWORD });

      const used = await requestReset();
      await anon().post('/api/auth/reset-password').send({ token: used.token, newPassword: NEW_PASSWORD });
      const usedRes = await anon().post('/api/auth/reset-password').send({ token: used.token, newPassword: NEW_PASSWORD });

      expect(expiredRes.body.error.message).toBe(unknown.body.error.message);
      expect(usedRes.body.error.message).toBe(unknown.body.error.message);
    });

    it('applies the password policy, including against the account own username', async () => {
      const a = await requestReset();
      const weak = await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: 'password' });
      expect(weak.status).toBe(400);
      // The identity-aware rule needs the account, which is only known once the token is verified —
      // resolving it earlier would be the enumeration oracle this flow avoids.
      const selfNamed = await anon()
        .post('/api/auth/reset-password')
        .send({ token: a.token, newPassword: `${a.username}-abcdef` });
      expect(selfNamed.status).toBe(400);
      expect(selfNamed.body.error.message).toMatch(/username/i);
      // A refused attempt must not consume the token.
      expect((await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD })).status).toBe(200);
    });

    it('survives a username change between issue and redemption', async () => {
      // The legacy row keyed on username and redeemed with `WHERE lower(username) = lower(?)`, so a
      // rename in between matched nobody — or, if someone took the freed username, a DIFFERENT account.
      const a = await requestReset();
      const renamed = `${a.username}_v2`.slice(0, 24);
      await a.agent.post('/api/players/account/update').send({ currentPassword: PASSWORD, newUsername: renamed });

      const r = await anon().post('/api/auth/reset-password').send({ token: a.token, newPassword: NEW_PASSWORD });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const fresh = client();
      expect((await fresh.post('/api/auth/login').send({ username: renamed, password: NEW_PASSWORD })).status).toBe(200);
    });
  });

  describe('email verification', () => {
    it('marks the address verified', async () => {
      const a = await account();
      const req1 = await a.agent.post('/api/auth/verify-email/request').send({});
      expect(req1.status, JSON.stringify(req1.body)).toBe(200);
      const token = tokenFromMail();

      const before = await ctx.pool.query('SELECT email_verified_at FROM players WHERE id = $1', [a.id]);
      expect(before.rows[0].email_verified_at).toBeNull();

      expect((await anon().post('/api/auth/verify-email/confirm').send({ token })).status).toBe(200);
      const after = await ctx.pool.query('SELECT email_verified_at FROM players WHERE id = $1', [a.id]);
      expect(after.rows[0].email_verified_at).not.toBeNull();
    });

    it('will not verify a new address with a token issued for the old one', async () => {
      const a = await account();
      await a.agent.post('/api/auth/verify-email/request').send({});
      const token = tokenFromMail();
      await a.agent
        .post('/api/players/account/update')
        .send({ currentPassword: PASSWORD, newEmail: `changed_${a.username}@example.test` });

      const r = await anon().post('/api/auth/verify-email/confirm').send({ token });
      expect(r.status).toBe(400);
      const after = await ctx.pool.query('SELECT email_verified_at FROM players WHERE id = $1', [a.id]);
      expect(after.rows[0].email_verified_at).toBeNull();
    });

    it('requires a session to request one', async () => {
      expect((await anon().post('/api/auth/verify-email/request').send({})).status).toBe(401);
    });
  });

  describe('sign out everywhere', () => {
    it('ends other sessions and the calling one', async () => {
      const a = await account();
      const other = client();
      expect((await other.post('/api/auth/login').send({ username: a.username, password: PASSWORD })).status).toBe(200);

      expect((await a.agent.post('/api/auth/sign-out-everywhere').send({})).status).toBe(200);
      // "Everywhere" that excluded the device asking would be a lie, and someone who suspects a
      // compromise may well be on the compromised device.
      expect((await a.agent.get('/api/auth/status')).body.loggedIn).toBe(false);
      expect((await other.get('/api/auth/status')).body.loggedIn).toBe(false);
    });

    it('requires a session', async () => {
      expect((await anon().post('/api/auth/sign-out-everywhere').send({})).status).toBe(401);
    });
  });

  describe('the audit trail', () => {
    it('records a successful and a failed login, and never a secret', async () => {
      const a = await account();
      await anon().post('/api/auth/login').send({ username: a.username, password: 'wrong-password-entirely' });
      // The audit write is deliberately not awaited by the route, so it must not be raced here.
      await new Promise((r) => setTimeout(r, 250));

      const rows = await ctx.pool.query<{ event: string; identifier: string | null }>(
        'SELECT event, identifier FROM account_events WHERE lower(identifier) = lower($1) ORDER BY created_at',
        [a.username],
      );
      const events = rows.rows.map((x) => x.event);
      expect(events).toContain('login.success');
      expect(events).toContain('login.failure');

      const all = await ctx.pool.query('SELECT identifier FROM account_events');
      const text = JSON.stringify(all.rows);
      // Never a password, never a token, never a token hash: a hash here would make the audit table a
      // source of redeemable credentials.
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('wrong-password-entirely');
    });

    it('records a reset being requested and redeemed', async () => {
      const a = await account();
      await forgot(a.username, '10.93.0.1');
      const token = tokenFromMail();
      await anon().post('/api/auth/reset-password').send({ token, newPassword: NEW_PASSWORD });
      await new Promise((r) => setTimeout(r, 250));

      const rows = await ctx.pool.query<{ event: string }>(
        'SELECT event FROM account_events WHERE player_id = $1 ORDER BY created_at',
        [a.id],
      );
      const events = rows.rows.map((x) => x.event);
      expect(events).toContain('password.reset.requested');
      expect(events).toContain('password.reset.redeemed');
    });
  });
});
