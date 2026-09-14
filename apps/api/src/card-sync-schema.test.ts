import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The legacy card sync's Postgres upsert, executed against the migrated schema.
 *
 * `scryfallService.js` is only reachable behind a ~500MB download from Scryfall, so its SQL had
 * never been run against Postgres by anything — which is how it shipped naming a `scryfall_id`
 * column that `scryfall_cards` does not have. Every insert raised, the import loop's catch
 * (labelled "Ignore parse errors" but wrapping the write too) discarded it, and the sync reported
 * success having written nothing.
 *
 * `scryfall_cards` is what `apps/api`'s card search reads, so a sync that cannot write is a v2
 * problem, not only a legacy one. This runs the statement itself — no download, no network.
 */
const require_ = createRequire(import.meta.url);

describe.skipIf(!DATABASE_URL)('legacy card sync statement (requires DATABASE_URL)', () => {
  let pool: pg.Pool;
  const dbName = `grimore_cardsync_test_${Date.now()}`;
  let CARD_UPSERT_PG: string;

  // A row shaped exactly as the import loop builds one, in the same parameter order.
  const row = (id: string, overrides: Partial<Record<number, unknown>> = {}) => {
    const params: unknown[] = [
      id, // $1 id
      'Scrap Mastery', // $2 name (also card_name)
      'c15', // $3 set_code
      'Commander 2015', // $4 set_name
      '42', // $5 collector_number
      'Sorcery', // $6 type_line
      'Each player exiles all artifact cards from their graveyard.', // $7 oracle_text
      '{4}{R}', // $8 mana_cost
      5, // $9 cmc
      JSON.stringify(['R']), // $10 colors
      3.25, // $11 price
      'https://cards.scryfall.io/normal/front/a/b/abc.jpg', // $12 image_uri
      'rare', // $13 rarity
    ];
    for (const [i, v] of Object.entries(overrides)) params[Number(i)] = v;
    return params;
  };

  beforeAll(async () => {
    ({ CARD_UPSERT_PG } = require_('../../../scryfallService.js'));

    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
    const { runMigrations } = await import('@grimore/db');
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('names only columns that exist on scryfall_cards', async () => {
    // The direct assertion of the bug: before the fix this listed scryfall_id, which is absent.
    const named = CARD_UPSERT_PG.split('VALUES')[0]
      .replace(/[\s\S]*\(/, '')
      .replace(/\)[\s\S]*/, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'scryfall_cards'`,
    );
    const actual = new Set(cols.rows.map((r) => r.column_name as string));
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((c) => !actual.has(c))).toEqual([]);
  });

  it('inserts a card', async () => {
    await pool.query(CARD_UPSERT_PG, row('id-insert'));
    const got = await pool.query('SELECT * FROM scryfall_cards WHERE id = $1', ['id-insert']);
    expect(got.rowCount).toBe(1);
    expect(got.rows[0].name).toBe('Scrap Mastery');
    // name is written to card_name as well — the column the search indexes are on.
    expect(got.rows[0].card_name).toBe('Scrap Mastery');
    expect(got.rows[0].rarity).toBe('rare');
  });

  it('refreshes every non-key column on re-sync, not just six of them', async () => {
    await pool.query(CARD_UPSERT_PG, row('id-resync'));
    await pool.query(
      CARD_UPSERT_PG,
      row('id-resync', {
        6: 'Errata: each player exiles all artifact cards from their graveyard, then returns them.',
        12: 'mythic',
        3: 'Commander 2015 Edition',
        9: JSON.stringify(['R', 'W']),
      }),
    );
    const got = await pool.query('SELECT * FROM scryfall_cards WHERE id = $1', ['id-resync']);
    expect(got.rowCount).toBe(1);
    // Each of these was left stale by the old conflict clause.
    expect(got.rows[0].oracle_text).toContain('then returns them');
    expect(got.rows[0].rarity).toBe('mythic');
    expect(got.rows[0].set_name).toBe('Commander 2015 Edition');
    expect(got.rows[0].colors).toBe(JSON.stringify(['R', 'W']));
  });

  it('leaves price NULL when Scryfall has none, so the COALESCE floor applies', async () => {
    await pool.query(CARD_UPSERT_PG, row('id-nullprice', { 10: null }));
    const got = await pool.query('SELECT price FROM scryfall_cards WHERE id = $1', ['id-nullprice']);
    expect(got.rows[0].price).toBeNull();
  });
});
