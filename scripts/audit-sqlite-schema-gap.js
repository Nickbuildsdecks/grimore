#!/usr/bin/env node
/**
 * What the legacy server writes that the **local SQLite** store does not have.
 *
 * ## Why this exists, and why it is the other half of an audit that already existed
 *
 * `scripts/audit-postgres-schema-gap.js` asks: what does **Postgres** not have that `server.js`
 * writes. `claude/postgres-schema-gap-2026-09-27.md` is its write-up, and between them they are a
 * careful record of this repository's schema divergence.
 *
 * Every bit of that record looks the same way round. Nobody had asked what **local SQLite** does not
 * have — and local is the environment CLAUDE.md's workflow names first: *"Test Locally First: always
 * implement, run, and verify changes on local server (http://localhost:3000)"*. Running the
 * project's own master test suite (#311) found the answer was "a lot": the home feed, the player
 * profile and the metagame endpoint all answered 500 on a freshly created local database, and
 * `INSERT INTO decks (... is_public, format)` named columns that did not exist, so creating a deck
 * could not work at all. Twenty-one columns were missing. `db.js` now adds fifteen of them; this
 * script is what says whether any are left.
 *
 * ## What it reads, and the one trap in reading it
 *
 * `INSERT INTO <table> (<columns>)` in `server.js`, compared against the live SQLite catalog after
 * `initDb()` has run. INSERTs rather than every reference, for the reason the Postgres audit gives:
 * a SELECT of a missing column fails too, but an INSERT is where the two schemas were written
 * apart, and it names its columns explicitly.
 *
 * The trap is the dialect ternary. `server.js` writes
 *
 *     const SQL = db.isPostgres
 *       ? `INSERT INTO collection_cards (..., foil, ...)`
 *       : `INSERT INTO collection_cards (..., is_foil, ...)`
 *
 * so **the Postgres branch must be skipped here**, exactly as the Postgres audit skips the SQLite
 * branch. The first draft of this detector matched `isPostgres ?` on the same line, which fails on
 * the multi-line form above, and it reported seven missing columns. Six were the Postgres spelling
 * of a column SQLite has under another name — `foil`/`is_foil`, `created_at`/`added_at`,
 * `cached_at`/`last_updated`, `id`/`scryfall_id`, `name`/`card_name` — every one a false positive,
 * and every one an argument for a change that would have reintroduced a fixed bug. With the
 * detector corrected to the mirror of the existing one (a line opening with `?`), one column is
 * left.
 *
 * ## Run it
 *
 *     node scripts/audit-sqlite-schema-gap.js
 *
 * `initDb()` runs first, because the question is what the **schema the app builds** is missing, not
 * what some older file on disk happens to hold.
 *
 * The strongest form of the audit is against a database built from nothing, and `db.js` resolves its
 * SQLite path at require time with no environment override, so that is done by moving the file
 * aside rather than with a flag:
 *
 *     mv grimore.db grimore.db.keep && node scripts/audit-sqlite-schema-gap.js
 *     rm -f grimore.db grimore.db-wal grimore.db-shm && mv grimore.db.keep grimore.db
 *
 * (This paragraph replaces a `DB_PATH=` line in the first draft of this file. There is no such
 * variable. A documented flag that does not exist is a claim that cannot be true, which is the same
 * fault as a check that cannot fail.)
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

/**
 * Is the match at `index` on a line that opens the **Postgres** branch of a `db.isPostgres` ternary?
 *
 * The mirror of `sqliteBranchOfTernary` in the Postgres audit, and deliberately the same shape of
 * test — a line's first non-space character — rather than a proximity window, for the same reason
 * that one gives: a window is not good enough.
 */
function postgresBranchOfTernary(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  return source.slice(lineStart, index).trimStart().startsWith('?');
}

/** `{ table => Set<column> }` for every INSERT in `file` that runs on SQLite. */
function insertedColumns(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const re = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  const out = new Map();
  let m;
  while ((m = re.exec(source))) {
    if (postgresBranchOfTernary(source, m.index)) continue;
    const table = m[1].toLowerCase();
    const cols = m[2]
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
    if (!cols.length) continue;
    if (!out.has(table)) out.set(table, new Set());
    for (const c of cols) out.get(table).add(c);
  }
  return out;
}

async function main() {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) {
    // `db.js` picks its dialect from the environment, so a stray POSTGRES_URL would silently make
    // this audit read Postgres and report "nothing missing" about a database it was not asked about.
    console.error('POSTGRES_URL / DATABASE_URL is set, so db.js would open Postgres.');
    console.error('Unset them to audit the local SQLite store (that is what this script is for).');
    process.exit(1);
  }
  const db = require(join(ROOT, 'db.js'));
  await db.initDb();

  const want = insertedColumns('server.js');
  const tables = new Set(
    (await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => String(r.name)),
  );

  const missingTables = [];
  const missingColumns = [];
  for (const [table, cols] of [...want].sort()) {
    if (!tables.has(table)) { missingTables.push(table); continue; }
    const have = new Set(
      (await db.query(`PRAGMA table_info(${table})`)).map((r) => String(r.name)),
    );
    const gap = [...cols].filter((c) => !have.has(c)).sort();
    if (gap.length) missingColumns.push([table, gap]);
  }

  console.log(`\nTables server.js inserts into: ${want.size}`);
  console.log(`Tables in the local store: ${tables.size}`);

  if (!missingTables.length) {
    console.log('\nEvery table server.js inserts into exists locally.');
  } else {
    console.log(`\nTABLES server.js inserts into that do not exist locally (${missingTables.length}):`);
    for (const t of missingTables) console.log(`  ${t}`);
  }

  const columnCount = missingColumns.reduce((n, [, g]) => n + g.length, 0);
  if (!columnCount) {
    console.log('\nEvery column server.js inserts exists on the tables that are present.');
  } else {
    console.log(`\nCOLUMNS missing (${columnCount} across ${missingColumns.length} table(s)):`);
    for (const [t, g] of missingColumns) console.log(`  ${t.padEnd(22)} ${g.join(', ')}`);
  }

  console.log('\nA missing table or column is not a degraded feature: it is a 500 on the route.');
  console.log('See claude/postgres-schema-gap-2026-09-27.md for the same audit the other way round.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
