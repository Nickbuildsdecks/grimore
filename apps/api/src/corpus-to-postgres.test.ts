import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The corpus loader's statement, executed against the migrated schema.
 *
 * This file exists because of what D329 found: `scryfallService.js`' bulk upsert named a column
 * `scryfall_cards` does not have, every insert raised, the import loop's catch discarded it, and
 * the sync **reported success having written nothing**. The statement was wrong for months for one
 * reason — nothing had ever executed it, because executing it meant a 500MB download from a host
 * this container cannot reach.
 *
 * `scripts/corpus/to-postgres.mjs` writes the same table from a file on disk, so its SQL *can* be
 * executed, and here it is: the real `UPSERT`, the real `paramsFor`, real corpus rows, against a
 * freshly migrated database. Not a copy of the statement — a copy would have passed on the
 * `scryfall_id` version too.
 *
 * The four rows below are printed cards, quoted from the corpus the loader reads. They are not
 * fixtures invented to suit the assertions: each one is here because a real card's real data is
 * the awkward case. Abandoned Campground has no coloured mana cost and two colours in its text
 * box; Abominable Treefolk's power is `*`; Nicol Bolas, the Ravager is a transform layout whose
 * other face is a separate row; Lightning Bolt is the ordinary case that must not break.
 */
interface Loader {
  readonly UPSERT: string;
  readonly colorIdentityOf: (row: Record<string, unknown>) => readonly string[];
  readonly idFor: (name: string) => string;
  readonly paramsFor: (row: Record<string, unknown>) => readonly unknown[];
  readonly loadRows: (
    client: pg.Client,
    rows: readonly Record<string, unknown>[],
  ) => Promise<{ written: number; skipped: number }>;
}

/** Quoted from the corpus: a land whose only colours are the mana symbols in its text box. */
const CAMPGROUND = {
  name: 'Abandoned Campground',
  type_line: 'Land',
  oracle_text:
    'Abandoned Campground enters tapped unless a player has 13 or less life.\n{T}: Add {W} or {U}.',
  mana_cost: '',
  cmc: 0,
  colors: [],
  power: null,
  toughness: null,
  loyalty: null,
  layout: 'normal',
  legalities: {
    standard: 'legal', pioneer: 'legal', modern: 'legal', legacy: 'legal',
    vintage: 'legal', pauper: 'legal', commander: 'legal',
  },
};

/** Quoted from the corpus: a creature whose printed power and toughness are each `*`. */
const TREEFOLK = {
  name: 'Abominable Treefolk',
  type_line: 'Snow Creature — Treefolk',
  oracle_text:
    "Trample\nAbominable Treefolk's power and toughness are each equal to the number of snow permanents you control.\nWhen Abominable Treefolk enters, tap target creature an opponent controls. That creature doesn't untap during its controller's next untap step.",
  mana_cost: '{2}{G}{U}',
  cmc: 4,
  colors: ['G', 'U'],
  power: '*',
  toughness: '*',
  loyalty: null,
  layout: 'normal',
  legalities: {
    standard: 'not_legal', pioneer: 'not_legal', modern: 'legal', legacy: 'legal',
    vintage: 'legal', pauper: 'not_legal', commander: 'legal',
  },
};

/** Quoted from the corpus: the ordinary case, and the one every other test here is read against. */
const BOLT = {
  name: 'Lightning Bolt',
  type_line: 'Instant',
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  mana_cost: '{R}',
  cmc: 1,
  colors: ['R'],
  power: null,
  toughness: null,
  loyalty: null,
  layout: 'normal',
  legalities: {
    standard: 'not_legal', pioneer: 'not_legal', modern: 'legal', legacy: 'legal',
    vintage: 'legal', pauper: 'legal', commander: 'legal',
  },
};

describe.skipIf(!DATABASE_URL)('the corpus loader writes scryfall_cards (requires DATABASE_URL)', () => {
  let client: pg.Client;
  let loader: Loader;
  const dbName = `grimore_corpus_test_${Date.now()}`;

  beforeAll(async () => {
    const href = new URL('../../../scripts/corpus/to-postgres.mjs', import.meta.url).href;
    loader = (await import(/* @vite-ignore */ href)) as unknown as Loader;

    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    // A Client rather than a Pool: `loadRows` sends BEGIN and COMMIT, and on a pool those two can
    // land on different connections, which would leave a transaction open for ever and commit
    // nothing. The loader has the same reason for using a Client.
    client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
    const { runMigrations } = await import('@grimore/db');
    await runMigrations(pool);
    await pool.end();
  }, 60_000);

  afterAll(async () => {
    await client.end();
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  /*
    An empty table before each test, rather than a table carrying whatever the test above left.

    Written after the break run, which is what found the need for it: breaking the FORGE marking
    failed *two* tests, because the one that deletes `WHERE set_code = 'FORGE'` was also what
    cleaned up for the one after it. Those assertions were counting rows from two tests at once, so
    a count that was right for the wrong reason would have read green. With the table emptied here,
    every count below is this test's own and can be an equality.
  */
  beforeEach(async () => {
    await client.query('TRUNCATE scryfall_cards');
  });

  const rowFor = async (name: string) => {
    const got = await client.query('SELECT * FROM scryfall_cards WHERE name = $1', [name]);
    expect(got.rowCount, `no row for ${name}`).toBe(1);
    return got.rows[0] as Record<string, unknown>;
  };

  it('writes a printed card through the statement the loader actually runs', async () => {
    const { written, skipped } = await loader.loadRows(client, [BOLT]);
    expect({ written, skipped }).toEqual({ written: 1, skipped: 0 });
    const row = await rowFor('Lightning Bolt');
    // card_name as well as name: the search indexes are on card_name, and the two are fed by one
    // parameter precisely so they cannot drift.
    expect(row.card_name).toBe('Lightning Bolt');
    expect(row.type_line).toBe('Instant');
    expect(row.oracle_text).toBe('Lightning Bolt deals 3 damage to any target.');
    expect(row.mana_cost).toBe('{R}');
    expect(Number(row.cmc)).toBe(1);
    expect(row.layout).toBe('normal');
  });

  it('writes the legalities a format check reads, as the corpus gave them', async () => {
    await loader.loadRows(client, [BOLT]);
    const row = await rowFor('Lightning Bolt');
    const legal = typeof row.legalities === 'string'
      ? (JSON.parse(row.legalities) as Record<string, string>)
      : (row.legalities as Record<string, string>);
    // The point of loading legalities at all: these three answers are what decide whether a pasted
    // deck is a legal Commander deck or a legal Modern one, and `scryfall_cards` had neither.
    expect(legal.commander).toBe('legal');
    expect(legal.modern).toBe('legal');
    expect(legal.standard).toBe('not_legal');
  });

  it('derives colour identity from the text box, not only from the cost (CR 903.4)', async () => {
    /*
      The case `colors` gets wrong, and the reason this column is derived rather than left null.
      Abandoned Campground is a colourless land — no mana cost at all, `colors` empty — and its
      identity is white and blue, because CR 903.4 counts the mana symbols in the rules text. A
      Commander deck checker reading `colors` would let this land into a mono-red deck.
    */
    expect(loader.colorIdentityOf(CAMPGROUND)).toEqual(['U', 'W']);
    await loader.loadRows(client, [CAMPGROUND]);
    const row = await rowFor('Abandoned Campground');
    const identity = typeof row.color_identity === 'string'
      ? (JSON.parse(row.color_identity) as string[])
      : (row.color_identity as string[]);
    expect(identity).toEqual(['U', 'W']);
    const colors = typeof row.colors === 'string'
      ? (JSON.parse(row.colors) as string[])
      : (row.colors as string[]);
    expect(colors).toEqual([]);
  });

  it('keeps a printed * as printed, rather than as a number it is not', async () => {
    /*
      `power`, `toughness` and `loyalty` are TEXT because `*`, `1+*` and `X` are printed values —
      219 cards in the corpus have `*` power. An `integer` column would accept every other
      assertion in this file and silently drop exactly the cards whose size is a rule.
    */
    await loader.loadRows(client, [TREEFOLK]);
    const row = await rowFor('Abominable Treefolk');
    expect(row.power).toBe('*');
    expect(row.toughness).toBe('*');
    expect(row.loyalty).toBe(null);
  });

  it('writes the same card twice rather than a second row for it', async () => {
    /*
      The id is `sha1(name)` as a UUID, and this is what that buys: the load is idempotent, so a
      re-run updates rows instead of doubling them. A duplicate by name is not a cosmetic problem —
      it is the fan-out bug D23 and D24 both found, where joining `scryfall_cards` on `LOWER(name)`
      multiplied a card's weight by the number of rows it had.
    */
    expect(loader.idFor('Lightning Bolt')).toBe(loader.idFor('Lightning Bolt'));
    expect(loader.idFor('Lightning Bolt')).not.toBe(loader.idFor('Lightning Helix'));
    await loader.loadRows(client, [BOLT]);
    await loader.loadRows(client, [BOLT]);
    const got = await client.query('SELECT count(*)::int AS n FROM scryfall_cards WHERE name = $1', [
      'Lightning Bolt',
    ]);
    expect((got.rows[0] as { n: number }).n).toBe(1);
  });

  it('marks every row FORGE, so a real import can delete them before writing its own', async () => {
    /*
      Load-bearing rather than decorative. A real Scryfall import keys rows by its own printing ids,
      so without this marking the table would hold two rows per card — the fan-out above, arriving
      the day the egress opens. `DELETE WHERE set_code = 'FORGE'` is the prerequisite, and it only
      works if every row this loader writes carries the mark.
    */
    await loader.loadRows(client, [BOLT, CAMPGROUND, TREEFOLK]);
    const marked = await client.query(
      "SELECT count(*)::int AS n FROM scryfall_cards WHERE set_code <> 'FORGE'",
    );
    expect((marked.rows[0] as { n: number }).n).toBe(0);
    const gone = await client.query("DELETE FROM scryfall_cards WHERE set_code = 'FORGE'");
    expect(gone.rowCount).toBe(3);
    const left = await client.query('SELECT count(*)::int AS n FROM scryfall_cards');
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it('leaves the columns Forge has no data for null, rather than filled with a guess', async () => {
    /*
      Asserted rather than assumed, because the tempting thing to do with each of these is invent
      one. A null price falls through to `COALESCE(pc.price, sc.price, 0.15)`; a wrong price does
      not. A null `edhrec_rank` orders the suggestions arbitrarily; a made-up rank orders them
      wrongly and looks right. `keywords` is Scryfall's parsed vocabulary rather than this
      compiler's, and writing the compiler's list into it would make a later real import look like
      a change in the data. See the loader's header for the reason on each.
    */
    await loader.loadRows(client, [BOLT]);
    const row = await rowFor('Lightning Bolt');
    for (const column of [
      'price', 'foil_price', 'image_uri', 'scryfall_uri', 'rarity', 'collector_number',
      'edhrec_rank', 'keywords', 'card_faces', 'produced_mana',
    ]) {
      expect(row[column], `${column} should be null until a real import fills it`).toBe(null);
    }
    // `oracle_id` is the exception among the fields a printing-level import would carry: one row
    // per card means identity across printings is the row's own id.
    expect(row.oracle_id).toBe(row.id);
  });

  it('skips a nameless row instead of writing one under the empty name', async () => {
    /*
      Every nameless row would hash to the same id, so without the skip a corpus with two of them
      would upsert over each other and the load would report both as written. The loader reports
      them separately for the same reason the import does: a skip count that is not zero is a
      question about the corpus.
    */
    const { written, skipped } = await loader.loadRows(client, [
      { name: '', type_line: 'Instant' },
      { type_line: 'Instant' },
      BOLT,
    ]);
    expect({ written, skipped }).toEqual({ written: 1, skipped: 2 });
    const got = await client.query('SELECT count(*)::int AS n FROM scryfall_cards');
    expect((got.rows[0] as { n: number }).n).toBe(1);
  });

  it('names only columns scryfall_cards has, and fills every one of them', async () => {
    /*
      The direct assertion of D329's bug, on this statement: before that fix the legacy one listed
      `scryfall_id`, which is absent. Equalities rather than bounds — the old bound passed just as
      well on the 13-column statement as on the 28-column one, so it could not have said that
      `legalities` and `color_identity` were being left empty.
    */
    const named = loader.UPSERT.split('VALUES')[0]!
      .replace(/[\s\S]*\(/, '')
      .replace(/\)[\s\S]*/, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const cols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'scryfall_cards'",
    );
    const actual = new Set(cols.rows.map((r) => (r as { column_name: string }).column_name));
    expect(named.length).toBe(28);
    expect(named.filter((c) => !actual.has(c))).toEqual([]);
    expect(actual.size).toBe(28);
    // 26 parameters for 28 columns: `name` and `card_name` share $2, and `last_updated` is
    // CURRENT_TIMESTAMP. The row builder supplies exactly those 26, which is what makes a future
    // migration's new column show up here as a failure rather than as a quietly empty field.
    expect(new Set(loader.UPSERT.match(/\$\d+/g) ?? []).size).toBe(26);
    expect(loader.paramsFor(BOLT)).toHaveLength(26);
  });

  it('refreshes on conflict every column it inserts', async () => {
    /*
      Structural, because the thing that goes wrong when a statement like this is widened is
      forgetting half of it: the legacy one refreshed six of the thirteen columns it inserted, so a
      re-sync wrote a card's new oracle text into a row that kept the old set name. `id` is the
      conflict key; `name` and `card_name` share $2.
    */
    const refreshed = new Set(
      (loader.UPSERT.split('DO UPDATE SET')[1] ?? '')
        .split(',')
        .map((a) => a.split('=')[0]!.trim())
        .filter(Boolean),
    );
    const named = loader.UPSERT.split('VALUES')[0]!
      .replace(/[\s\S]*\(/, '')
      .replace(/\)[\s\S]*/, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const missing = named.filter((c) => c !== 'id' && !refreshed.has(c));
    expect(missing, `inserted but never refreshed: ${missing.join(', ')}`).toEqual([]);
  });
});
