/**
 * Minimal, dependency-free forward-only SQL migrator.
 *
 * - Migrations live in `migrations/NNNN_name.sql`, applied in filename order.
 * - Each migration runs in its own transaction and is recorded in `v2_migrations`.
 * - A global advisory lock prevents two API machines from migrating at once.
 * - 0001_baseline.sql is the exact schema the legacy app creates (pg_dump of initDb()).
 *   On a database that already has the legacy tables, 0001 is *marked* applied, not re-run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LOCK_KEY = 0x6772696d; // "grim"

export interface MigrationRecord {
  name: string;
  applied_at: string;
}

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // works from both src/ (vitest) and dist/ (runtime)
  return join(here, '..', 'migrations');
}

export function listMigrationFiles(dir = migrationsDir()): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS v2_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function legacySchemaPresent(client: pg.PoolClient): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='players'`,
  );
  return (r.rowCount ?? 0) > 0;
}

export async function migrationStatus(pool: pg.Pool): Promise<{ applied: string[]; pending: string[] }> {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const r = await client.query<MigrationRecord>('SELECT name FROM v2_migrations ORDER BY name');
    const applied = r.rows.map((x) => x.name);
    const pending = listMigrationFiles().filter((f) => !applied.includes(f));
    return { applied, pending };
  } finally {
    client.release();
  }
}

export async function runMigrations(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const ran: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);
    const appliedRows = await client.query<MigrationRecord>('SELECT name FROM v2_migrations');
    const applied = new Set(appliedRows.rows.map((r) => r.name));
    const dir = migrationsDir();
    for (const file of listMigrationFiles(dir)) {
      if (applied.has(file)) continue;
      const isBaseline = file.startsWith('0001_');
      if (isBaseline && (await legacySchemaPresent(client))) {
        await client.query('INSERT INTO v2_migrations(name) VALUES ($1)', [file]);
        log(`[migrate] ${file}: legacy schema detected, marked as applied`);
        ran.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO v2_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${file} failed: ${(err as Error).message}`);
      }
      log(`[migrate] applied ${file}`);
      ran.push(file);
    }
    return ran;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      /* ignore */
    }
    client.release();
  }
}

// CLI: node dist/migrate.js up|status
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const cmd = process.argv[2] ?? 'up';
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const done = async () => {
    await pool.end();
  };
  if (cmd === 'status') {
    migrationStatus(pool)
      .then((s) => {
        console.log(JSON.stringify(s, null, 2));
        return done();
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    runMigrations(pool, console.log)
      .then((r) => {
        console.log(`[migrate] ${r.length} migration(s) applied`);
        return done();
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
