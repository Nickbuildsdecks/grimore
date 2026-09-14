import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface DbOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
}

/**
 * Create a pooled Postgres client. Point `connectionString` at Neon's *pooled* endpoint in
 * production. `ssl` defaults to true for any non-local host.
 */
export function createPool(opts: DbOptions): pg.Pool {
  const url = new URL(opts.connectionString);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: opts.ssl ?? (local ? false : { rejectUnauthorized: true }),
  });
  pool.on('error', (err) => {
    // Idle-client errors must never crash the process.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * Real transaction: pins ONE client for the whole callback, commits on success, rolls back on throw.
 * (The legacy app's "withTransaction" ran statements on the pool and was a no-op.)
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(pool: pg.Pool): Promise<boolean> {
  const r = await pool.query('SELECT 1 AS ok');
  return r.rows[0]?.ok === 1;
}

export { runMigrations, migrationStatus } from './migrate.js';
