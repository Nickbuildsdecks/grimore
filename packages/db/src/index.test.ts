import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, withTransaction, ping, runMigrations, migrationStatus } from './index.js';
import { listMigrationFiles } from './migrate.js';
const lmf = listMigrationFiles;
import pg from 'pg';

const url = process.env.DATABASE_URL;
const ADMIN = url ? new URL(url) : null;

describe('migration files', () => {
  it('are ordered and include the baseline', () => {
    const files = lmf();
    expect(files[0]).toMatch(/^0001_baseline\.sql$/);
    expect(files).toEqual([...files].sort());
  });
});

describe.skipIf(!url)('database (requires DATABASE_URL)', () => {
  let pool: pg.Pool;
  const dbName = `grimore_test_${Date.now()}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = createPool({ connectionString: u.toString(), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('pings', async () => {
    expect(await ping(pool)).toBe(true);
  });

  it('applies all migrations on a fresh database, idempotently', async () => {
    const ran = await runMigrations(pool);
    expect(ran.length).toBe(listMigrationFiles().length);
    const again = await runMigrations(pool);
    expect(again).toEqual([]);
    const status = await migrationStatus(pool);
    expect(status.pending).toEqual([]);
    const tables = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'v2_migrations'`,
    );
    expect(tables.rows[0].n).toBe(30);
  });

  it('withTransaction commits on success and rolls back on throw', async () => {
    await pool.query('CREATE TEMP TABLE IF NOT EXISTS tx_probe(x int)'); // temp is per-connection; use a real table instead
    await pool.query('CREATE TABLE IF NOT EXISTS tx_probe_real(x int)');
    await withTransaction(pool, async (c) => {
      await c.query('INSERT INTO tx_probe_real VALUES (1)');
    });
    await expect(
      withTransaction(pool, async (c) => {
        await c.query('INSERT INTO tx_probe_real VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const r = await pool.query('SELECT x FROM tx_probe_real ORDER BY x');
    expect(r.rows.map((x) => x.x)).toEqual([1]);
  });
});
