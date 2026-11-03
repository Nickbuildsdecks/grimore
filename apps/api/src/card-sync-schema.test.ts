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

  /*
    A row shaped exactly as the import loop builds one, in the same parameter order.

    The parameter list grew from 13 to 26 when the importer started writing the fields a rules
    engine needs (migration 0015). The thirteen it never wrote are not padding: `legalities` is how
    a Commander deck is checked, `color_identity` is the rule that decides what may go in it,
    `produced_mana` is the difference between a land needing a hand-written script and not, and
    `power`/`toughness`/`loyalty` are TEXT because `*`, `1+*` and `X` are printed values. The
    fixture below carries the awkward ones deliberately — see the `*` power and the `X` loyalty
    overrides in the tests — because a column typed `integer` would accept every assertion in this
    file and then drop exactly the cards whose size is a rule.
  */
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
      JSON.stringify(['R']), // $14 color_identity
      JSON.stringify({ commander: 'legal', modern: 'not_legal' }), // $15 legalities
      JSON.stringify([]), // $16 keywords
      null, // $17 card_faces
      8421, // $18 edhrec_rank
      'https://scryfall.com/card/c15/42/scrap-mastery', // $19 scryfall_uri
      11.5, // $20 foil_price
      null, // $21 power
      null, // $22 toughness
      null, // $23 loyalty
      'normal', // $24 layout
      'f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1', // $25 oracle_id
      null, // $26 produced_mana
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

  /** The column names the INSERT lists, in order. */
  const namedColumns = () =>
    CARD_UPSERT_PG.split('VALUES')[0]
      .replace(/[\s\S]*\(/, '')
      .replace(/\)[\s\S]*/, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

  it('names only columns that exist on scryfall_cards', async () => {
    // The direct assertion of the bug: before the fix this listed scryfall_id, which is absent.
    const named = namedColumns();
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'scryfall_cards'`,
    );
    const actual = new Set(cols.rows.map((r) => r.column_name as string));
    /*
      Equalities, not `toBeGreaterThan(10)`. The old bound passed just as well on the statement
      that wrote 13 columns as on the one that writes 28, so it could not have told anyone the
      importer was leaving `legalities` and `color_identity` empty.

      The two counts differ and both are asserted, because the first draft of this check asserted
      26 columns and failed at 28 — `name` and `card_name` are two columns fed by the same `$2`,
      and `last_updated` is CURRENT_TIMESTAMP rather than a parameter. So: 28 columns written, 26
      parameters, and the row builder below supplies exactly those 26. Every column of
      `scryfall_cards` is in that list; if a future migration adds one, this count is what says the
      importer has not been taught to fill it.
    */
    expect(named.length).toBe(28);
    expect(named.filter((c) => !actual.has(c))).toEqual([]);
    expect(actual.size).toBe(28);

    const placeholders = new Set(CARD_UPSERT_PG.match(/\$\d+/g) ?? []);
    expect(placeholders.size).toBe(26);
    expect(row('id-count')).toHaveLength(26);
  });

  it('refreshes on conflict every column it inserts', async () => {
    /*
      Structural, because the thing that goes wrong when this statement is widened is forgetting
      half of it: the conflict clause used to refresh six columns of the thirteen it inserted, so a
      re-sync wrote a card's new oracle text into a row that kept the old rarity and set name.
      Rather than re-test that one card at a time, assert that every inserted column appears in the
      SET list. `id` is the conflict key and is not refreshed; `card_name` and `name` share $2.
    */
    const refreshed = new Set(
      (CARD_UPSERT_PG.split('DO UPDATE SET')[1] ?? '')
        .split(',')
        .map((a) => a.split('=')[0].trim())
        .filter(Boolean),
    );
    const missing = namedColumns().filter((c) => c !== 'id' && !refreshed.has(c));
    expect(missing, `inserted but never refreshed: ${missing.join(', ')}`).toEqual([]);
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

  it('writes the rules fields the engine reads, including the ones that are not numbers', async () => {
    /*
      A creature whose power is `*` and whose toughness is `1+*`, and a planeswalker printed with
      `X` loyalty. These are the rows an `integer` column would silently refuse, and they are real
      cards — the size being a fact about the board is the whole point of the card. The statement
      has to accept them, and what comes back has to be the printed string, not a coerced 0.
    */
    await pool.query(
      CARD_UPSERT_PG,
      row('id-rules', {
        13: JSON.stringify(['B', 'G']), // color_identity wider than colors
        15: JSON.stringify(['Flying', 'Deathtouch']), // keywords
        20: '*', // power
        21: '1+*', // toughness
        22: 'X', // loyalty
        23: 'modal_dfc', // layout
        25: JSON.stringify(['B', 'G']), // produced_mana
      }),
    );
    const got = await pool.query('SELECT * FROM scryfall_cards WHERE id = $1', ['id-rules']);
    expect(got.rowCount).toBe(1);
    const c = got.rows[0];
    expect(c.power).toBe('*');
    expect(c.toughness).toBe('1+*');
    expect(c.loyalty).toBe('X');
    expect(c.layout).toBe('modal_dfc');
    expect(c.oracle_id).toBe('f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1');
    expect(JSON.parse(c.produced_mana)).toEqual(['B', 'G']);
    expect(JSON.parse(c.color_identity)).toEqual(['B', 'G']);
    expect(JSON.parse(c.keywords)).toEqual(['Flying', 'Deathtouch']);
    // Commander legality is the one legality the whole deck pool is checked against.
    expect(JSON.parse(c.legalities).commander).toBe('legal');
    expect(c.edhrec_rank).toBe(8421);
    expect(Number(c.foil_price)).toBe(11.5);
  });

  it('stores a two-faced card as faces, and keeps the fields that are rules', async () => {
    /*
      The trimmed shape the importer builds: eight rules fields a face, plus one image. The
      assertion that matters is that the back face survives the round trip at all — a modal DFC
      whose back is a land is unplayable if the engine can only see the front.
    */
    const faces = [
      {
        name: 'Agadeem, the Undercrypt',
        mana_cost: '{B}',
        type_line: 'Land',
        oracle_text: 'As this land enters, you may pay 3 life. If you do not, it enters tapped.',
        power: null,
        toughness: null,
        loyalty: null,
        colors: [],
        image_uri: null,
      },
      {
        name: 'Test Back Face',
        mana_cost: '{2}{B}',
        type_line: 'Creature — Test Zombie',
        oracle_text: 'Deathtouch',
        power: '*',
        toughness: '*',
        loyalty: null,
        colors: ['B'],
        image_uri: null,
      },
    ];
    await pool.query(CARD_UPSERT_PG, row('id-faces', { 16: JSON.stringify(faces), 23: 'modal_dfc' }));
    const got = await pool.query('SELECT card_faces FROM scryfall_cards WHERE id = $1', ['id-faces']);
    const back = JSON.parse(got.rows[0].card_faces)[1];
    expect(back.name).toBe('Test Back Face');
    expect(back.type_line).toContain('Creature');
    expect(back.power).toBe('*');
    expect(back.colors).toEqual(['B']);
  });

  it('refreshes the new rules columns on re-sync too, not only the original thirteen', async () => {
    // The errata case for the widened half: an oracle update that changes a creature's size.
    await pool.query(CARD_UPSERT_PG, row('id-rules-resync', { 20: '2', 21: '2' }));
    await pool.query(
      CARD_UPSERT_PG,
      row('id-rules-resync', {
        20: '3',
        21: '4',
        13: JSON.stringify(['R', 'G']),
        14: JSON.stringify({ commander: 'banned' }),
        25: JSON.stringify(['R']),
      }),
    );
    const got = await pool.query('SELECT * FROM scryfall_cards WHERE id = $1', ['id-rules-resync']);
    expect(got.rowCount).toBe(1);
    expect(got.rows[0].power).toBe('3');
    expect(got.rows[0].toughness).toBe('4');
    expect(JSON.parse(got.rows[0].color_identity)).toEqual(['R', 'G']);
    // A card that got banned has to stop being legal, or the deck checker keeps letting it in.
    expect(JSON.parse(got.rows[0].legalities).commander).toBe('banned');
    expect(JSON.parse(got.rows[0].produced_mana)).toEqual(['R']);
  });
});
