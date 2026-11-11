/**
 * The corpus, in the card table the product reads — the other half of #318.
 *
 * ## Why this exists
 *
 * `scryfall_cards` has **never held a row on Postgres**. `scryfallService.js`' bulk importer wrote
 * a `scryfall_id` column the table does not have, so every insert raised and the loop's catch —
 * labelled "ignore parse errors" and wrapping the write too — discarded it (D329 found that and
 * fixed the statement). The fixed importer still needs Scryfall's bulk file, and
 * `api.scryfall.com`, `data.scryfall.io`, `mtgjson.com` and `api.magicthegathering.io` are all
 * refused by this container's egress proxy, re-tested on every pass.
 *
 * But the data is **already on disk**. `scripts/corpus/from-forge.mjs` builds the printed card rows
 * out of `Card-Forge/forge`, which git can reach, and `scripts/corpus/legality.mjs` answers which
 * formats each card is legal in from the same repository. 33,847 rows, 31,654 of them legal in a
 * format the goal names. Loading that needs no egress at all — only the statement D329 hoisted out
 * of the import loop so something other than a 500MB download could execute it.
 *
 * So this is the importer's loop, over a file instead of a stream, and it is the step that makes
 * "upload any deck and play it" a question about the deck rather than about the pool.
 *
 * ## What it writes, and what it leaves null
 *
 * Written: `name`/`card_name`, `type_line`, `oracle_text`, `mana_cost`, `cmc`, `colors`,
 * `power`, `toughness`, `loyalty`, `layout`, `legalities`, and a derived `color_identity`.
 *
 * Null, deliberately, with the reason each time:
 *
 *  * `price` / `foil_price` / `image_uri` / `scryfall_uri` / `rarity` / `collector_number` —
 *    Forge's card files carry none of them. Every price query in the product already reads
 *    `COALESCE(pc.price, sc.price, 0.15)`, so a null price degrades to the default rather than to a
 *    wrong number, and the table draws card faces from text (D27) because no image host is
 *    reachable either.
 *  * `edhrec_rank` — a popularity figure from a site this container cannot reach. The deck
 *    suggestions route orders by it and will order arbitrarily until a real import lands, which is
 *    better than inventing a rank.
 *  * `keywords` — Scryfall's own parsed keyword list. The engine has `printedKeywords`, but that is
 *    *this* compiler's vocabulary, and writing it into a column named for Scryfall's would make a
 *    later real import look like a change in the data rather than in the source.
 *  * `card_faces` — written since D591 when the corpus row carries it. Forge keeps every face in
 *    the one card file, after an `ALTERNATE` line, and `from-forge.mjs` now emits them in
 *    Scryfall's shape; a corpus built before that has none, and the column stays null for it.
 *
 * ## The id, which is the one real design decision
 *
 * `scryfall_cards`' primary key is `id`, a Scryfall **printing** id, and Forge data has no ids at
 * all. So the id here is derived: `sha1(name)`, formatted as a UUID. That makes the load
 * **idempotent** — the same card writes the same row twice — and gives `oracle_id` (identity across
 * printings) the same value, which is honest for a corpus with one row per card rather than one per
 * printing.
 *
 * Every row is marked `set_code = 'FORGE'`, and that marking is load-bearing rather than
 * decorative: when Scryfall egress opens, the real import keys rows by its own printing ids and
 * would otherwise leave **two** rows per card — and a duplicate by name is the fan-out bug D23 and
 * D24 both found in the recommender and the suggestions route, where joining `scryfall_cards` by
 * `LOWER(name)` multiplied a card's weight by its print run. So the real import must delete
 * `WHERE set_code = 'FORGE'` first, and `--replace` here does the same thing for a re-load.
 *
 * ## Why the helpers are exported, and the main guard under them
 *
 * `UPSERT`, `paramsFor`, `colorIdentityOf` and `idFor` are exported, and the command-line body runs
 * only when this file *is* the command — the same hoist D329 made in `scryfallService.js`, for the
 * same reason. The bug D329 found was not a typo; it was a statement **nothing had ever executed**,
 * reporting success from inside a catch. A loader whose SQL is unreachable from a test is one
 * schema change away from being that bug again, so `corpus-to-postgres.test.ts` runs this exact
 * statement with these exact parameters against a freshly migrated database. Not a copy of it: a
 * copy would have passed on the `scryfall_id` version too.
 *
 * ## Usage
 *
 *   DATABASE_URL=postgres://… node scripts/corpus/to-postgres.mjs --file corpus.json [--legal-only]
 *     [--replace] [--limit N]
 *
 * `--legal-only` writes only the cards legal in a format the goal names, which is what a beta
 * tester's decks are built from; the default writes everything, because a card nobody can play in a
 * sanctioned format is still a card somebody might paste into a casual list.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { isLegal } from '../lib/legal.mjs';

/**
 * The card's colour identity (CR 903.4): every colour in its mana cost and in the mana symbols of
 * its rules text, including both halves of a hybrid.
 *
 * Derived rather than left null because it is what Commander legality is made of, and `colors` is
 * **not** a substitute — a card with a black symbol in its text box and no black in its cost has
 * black identity, which is exactly the case a deck checker gets wrong. The derivation is the rule
 * itself rather than a guess: the symbols are in the text this corpus already carries.
 *
 * Colour *indicators* (a card whose colour is printed as a dot rather than as a symbol) are not in
 * Forge's data, so a handful of those — the back faces of some transform cards — will read narrower
 * than they are. Stated rather than hidden.
 */
export const colorIdentityOf = (row) => {
  const seen = new Set();
  const text = `${row.mana_cost ?? ''}\n${row.oracle_text ?? ''}`;
  for (const [, body] of text.matchAll(/\{([^}]*)\}/g)) {
    for (const ch of body.toUpperCase()) if ('WUBRG'.includes(ch)) seen.add(ch);
  }
  for (const c of row.colors ?? []) if ('WUBRG'.includes(c)) seen.add(c);
  return [...seen].sort();
};

/** `sha1(name)` as a UUID, so a re-load writes the same row rather than a second one. */
export const idFor = (name) => {
  const hex = createHash('sha1').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const UPSERT = `
  INSERT INTO scryfall_cards
    (id, name, card_name, set_code, set_name, collector_number, type_line, oracle_text,
     mana_cost, cmc, colors, price, image_uri, rarity,
     color_identity, legalities, keywords, card_faces, edhrec_rank, scryfall_uri, foil_price,
     power, toughness, loyalty, layout, oracle_id, produced_mana, last_updated)
  VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, card_name = EXCLUDED.card_name, set_code = EXCLUDED.set_code,
    set_name = EXCLUDED.set_name, collector_number = EXCLUDED.collector_number,
    type_line = EXCLUDED.type_line, oracle_text = EXCLUDED.oracle_text,
    mana_cost = EXCLUDED.mana_cost, cmc = EXCLUDED.cmc, colors = EXCLUDED.colors,
    price = EXCLUDED.price, image_uri = EXCLUDED.image_uri, rarity = EXCLUDED.rarity,
    color_identity = EXCLUDED.color_identity, legalities = EXCLUDED.legalities,
    keywords = EXCLUDED.keywords, card_faces = EXCLUDED.card_faces,
    edhrec_rank = EXCLUDED.edhrec_rank, scryfall_uri = EXCLUDED.scryfall_uri,
    foil_price = EXCLUDED.foil_price,
    power = EXCLUDED.power, toughness = EXCLUDED.toughness, loyalty = EXCLUDED.loyalty,
    layout = EXCLUDED.layout, oracle_id = EXCLUDED.oracle_id,
    produced_mana = EXCLUDED.produced_mana,
    last_updated = CURRENT_TIMESTAMP`;

/**
 * One corpus row as the 26 parameters `UPSERT` takes, in order.
 *
 * A function rather than inline in the loop so a test can hand the real statement the real
 * parameters. `power`, `toughness` and `loyalty` stay strings: the columns are TEXT because `*`,
 * `1+*` and `X` are printed values, and a corpus row carries them as printed.
 */
export const paramsFor = (row) => {
  const id = idFor(row.name);
  return [
    id, row.name, 'FORGE', 'Forge corpus', null,
    row.type_line ?? null, row.oracle_text ?? null, row.mana_cost ?? null,
    Number.isFinite(row.cmc) ? row.cmc : null,
    JSON.stringify(row.colors ?? []), null, null, null,
    JSON.stringify(colorIdentityOf(row)),
    row.legalities === undefined ? null : JSON.stringify(row.legalities),
    // $16 keywords, then $17 card_faces: the faces `from-forge.mjs` writes for a two-faced card
    // (D591), in Scryfall's shape, so the engine can build the card's other face from the table.
    null, row.card_faces === undefined ? null : JSON.stringify(row.card_faces), null, null, null,
    row.power ?? null, row.toughness ?? null, row.loyalty ?? null,
    row.layout ?? null, id, null,
  ];
};

/**
 * Writes the rows, in transactions of a thousand, and says how many landed.
 *
 * One transaction over 34,000 upserts holds locks for the whole load; one per row pays an fsync
 * round trip per card. A row with no name is skipped rather than written under the id of the empty
 * string, which every nameless row would share.
 */
export async function loadRows(client, rows, { onProgress } = {}) {
  let written = 0;
  let skipped = 0;
  for (let at = 0; at < rows.length; at += 1000) {
    const batch = rows.slice(at, at + 1000);
    await client.query('BEGIN');
    for (const row of batch) {
      if (typeof row.name !== 'string' || row.name === '') { skipped += 1; continue; }
      await client.query(UPSERT, paramsFor(row));
      written += 1;
    }
    await client.query('COMMIT');
    if (onProgress) onProgress(written);
  }
  return { written, skipped };
}

async function main(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1];
  };

  const file = value('--file', null);
  if (file === null) {
    console.error('usage: node scripts/corpus/to-postgres.mjs --file corpus.json [--legal-only] [--replace] [--limit N]');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required; this writes Postgres and nothing else.');
    process.exit(2);
  }

  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const limit = Number(value('--limit', '0'));
  const chosen = rows
    .filter((row) => (flag('--legal-only') ? isLegal(row) : true))
    .slice(0, limit > 0 ? limit : undefined);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (flag('--replace')) {
      const gone = await client.query("DELETE FROM scryfall_cards WHERE set_code = 'FORGE'");
      console.log(`--replace: deleted ${gone.rowCount} rows previously loaded from this corpus.`);
    }
    const { written, skipped } = await loadRows(client, chosen, {
      onProgress: (n) => { if ((n / 1000) % 5 === 1 || n === chosen.length) console.log(`  … ${n} written`); },
    });
    const total = await client.query('SELECT count(*)::int AS n FROM scryfall_cards');
    const legalRows = await client.query(
      'SELECT count(*)::int AS n FROM scryfall_cards WHERE legalities IS NOT NULL',
    );
    console.log(`\nwritten: ${written}; skipped (no name): ${skipped}`);
    console.log(`scryfall_cards now holds ${total.rows[0].n} rows, ${legalRows.rows[0].n} with legalities.`);
  } finally {
    await client.end();
  }
}

// Only when this file is the command. See "Why the helpers are exported" above: importing it must
// not connect to anything, or the test that executes its statement would run the whole load.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
