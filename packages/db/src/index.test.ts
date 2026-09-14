import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, withTransaction, ping, runMigrations, migrationStatus } from './index.js';
import { listMigrationFiles } from './migrate.js';
const lmf = listMigrationFiles;
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // 31 from the baseline, +1 friend_requests (0007), +1 wishlist_cards (0008), +3 active_roster /
    // pods / pod_results (0009). Migrations 0004-0006 alter existing tables rather than adding any.
    expect(tables.rows[0].n).toBe(36);
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

/**
 * 0005 changes `collections.id` from an integer serial to TEXT, because every application handler
 * writes a `col_<ts>_<rand>` id. Production already holds rows written before the Postgres cutover,
 * so the conversion has to preserve them and keep the collection_cards foreign key intact. A fresh
 * database exercises the empty-table path only; this seeds legacy-shaped rows first.
 */
describe.skipIf(!url)('0005 collections id conversion (requires DATABASE_URL)', () => {
  let pool: pg.Pool;
  const dbName = `grimore_mig_test_${Date.now()}`;
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = createPool({ connectionString: u.toString(), max: 2 });
    // Everything up to, but not including, the conversion.
    for (const f of lmf().filter((n) => n < '0005')) {
      await pool.query(readFileSync(join(dir, f), 'utf8'));
    }
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('preserves rows, foreign keys and cascade behaviour', async () => {
    await pool.query(`INSERT INTO players (id, username, password_hash, store_nickname) VALUES ('p_1','u','h','U')`);
    await pool.query(`INSERT INTO collections (player_id, name) VALUES ('p_1','Binder A'), ('p_1','Binder B')`);
    await pool.query(
      `INSERT INTO collection_cards (collection_id, card_name, quantity)
       SELECT id, 'Sol Ring', 3 FROM collections WHERE name = 'Binder A'`,
    );
    const before = await pool.query('SELECT id FROM collections ORDER BY id');
    expect(before.rows.map((r) => r.id)).toEqual([1, 2]);

    await pool.query(readFileSync(join(dir, '0005_collections_ids_and_columns.sql'), 'utf8'));

    // Integer ids become their own decimal strings, so nothing is orphaned.
    const after = await pool.query(
      `SELECT c.id, pg_typeof(c.id)::text AS type, cc.card_name, cc.condition, cc.language, cc.is_for_trade
       FROM collections c LEFT JOIN collection_cards cc ON cc.collection_id = c.id ORDER BY c.id`,
    );
    expect(after.rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(after.rows[0].type).toBe('text');
    expect(after.rows[0].card_name).toBe('Sol Ring');
    // Columns added by the same migration take their defaults on existing rows.
    expect(after.rows[0].condition).toBe('NM');
    expect(after.rows[0].language).toBe('EN');
    expect(after.rows[0].is_for_trade).toBe(0);

    // The foreign key went back on with its ON DELETE CASCADE.
    await pool.query(`DELETE FROM collections WHERE name = 'Binder A'`);
    expect((await pool.query('SELECT 1 FROM collection_cards')).rowCount).toBe(0);

    // And the table now accepts the text ids the application actually writes.
    await pool.query(`INSERT INTO collections (id, player_id, name) VALUES ('col_123_abc','p_1','Text Id')`);
    const text = await pool.query(`SELECT settings FROM collections WHERE id = 'col_123_abc'`);
    expect(text.rows[0].settings).toBe('{}');
  });

  it('gives the card identity index NULL-safe, case-insensitive uniqueness', async () => {
    await pool.query(
      `INSERT INTO collection_cards (collection_id, card_name, quantity, scryfall_id)
       VALUES ('col_123_abc', 'Sol Ring', 1, NULL)`,
    );
    // Postgres treats NULLs as distinct in a plain unique index, so this row would otherwise duplicate.
    await expect(
      pool.query(
        `INSERT INTO collection_cards (collection_id, card_name, quantity, scryfall_id)
         VALUES ('col_123_abc', 'sol ring', 1, NULL)`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
