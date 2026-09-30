#!/usr/bin/env node
/**
 * Which tables and columns does the legacy server write that do not exist on Postgres?
 *
 * Legacy's two schemas have diverged: `db.js` builds one table set for SQLite and a different one
 * for Postgres, and `server.js` writes assuming SQLite. A missing table is not a dialect quirk --
 * the feature is simply dead on Postgres, failing with `relation "x" does not exist` wherever it is
 * touched.
 *
 * Read-only. Point it at any database and it reports what is absent:
 *
 *   node scripts/audit-postgres-schema-gap.js "postgresql://user:pass@host:5432/db"
 *
 * Table names come from SQL string literals only, never from the file at large. Matching raw source
 * text picks up English from comments -- "FROM the previous run", "UPDATE your deck" -- and drowns
 * the real findings in prose.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

const ROOT = join(__dirname, '..');
// A statement STARTS with a verb. Merely containing one matches prose -- an error string like
// "Failed to UPDATE your deck" would otherwise contribute "your" as a table name.
const TABLE_REF = /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi;

/**
 * Deciding what is a table name.
 *
 * Extracting SQL string literals from JavaScript with regexes does not work: a quote regex pairs an
 * apostrophe in one comment with a quote hundreds of lines away and returns a slab of code, so the
 * "SQL" it yields is prose and the audit fills with table names like "the" and "your". Parsing the
 * file properly would need a JS parser, which is a dependency this script does not justify.
 *
 * So the candidate list is filtered by what a table name actually looks like here instead:
 *
 *  - it is a table defined somewhere in the repo (db.js or a migration), or
 *  - it is snake_case with an underscore, which every multi-word table here is and almost no
 *    English word after FROM/INTO/UPDATE/JOIN is.
 *
 * The first rule is exact for anything with a definition. The second exists to catch tables that
 * are referenced but defined nowhere at all -- the worst case, and the one a definition-based check
 * would silently miss.
 */
function definedTableNames() {
  const { readdirSync } = require('node:fs');
  const names = new Set();
  const collect = (src) => {
    const re = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(src))) names.add(m[1].toLowerCase());
  };
  for (const f of readdirSync(join(ROOT, 'packages/db/migrations'))) {
    collect(readFileSync(join(ROOT, 'packages/db/migrations', f), 'utf8'));
  }
  collect(readFileSync(join(ROOT, 'db.js'), 'utf8'));
  return names;
}

function referencedTables(file) {
  const defined = definedTableNames();
  const source = readFileSync(join(ROOT, file), 'utf8');
  const found = new Map(); // table -> Set(verb)
  let m;
  TABLE_REF.lastIndex = 0;
  while ((m = TABLE_REF.exec(source))) {
    const name = m[1].toLowerCase();
    if (!defined.has(name) && !name.includes('_')) continue;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(m[0].split(/\s+/)[0].toUpperCase());
  }
  return found;
}

/** Where, if anywhere, a table is defined: a v2 migration, legacy db.js, or nothing. */
function definitionSites(table) {
  const sites = [];
  const { readdirSync } = require('node:fs');
  for (const f of readdirSync(join(ROOT, 'packages/db/migrations')).sort()) {
    const src = readFileSync(join(ROOT, 'packages/db/migrations', f), 'utf8');
    if (new RegExp(`CREATE TABLE (IF NOT EXISTS )?(public\\.)?${table}\\b`, 'i').test(src)) sites.push(f);
  }
  const legacy = readFileSync(join(ROOT, 'db.js'), 'utf8');
  if (new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`, 'i').test(legacy)) sites.push('db.js');
  return sites;
}

/**
 * Columns the server writes, per table, taken from INSERT column lists.
 *
 * `INSERT INTO <table> (<cols>)` is distinctive enough to match directly -- it needs none of the
 * literal-extraction that made the table check unreliable, because the table name and parenthesised
 * list only occur together in real SQL.
 *
 * INSERTs specifically, rather than every reference: a SELECT of a missing column fails too, but an
 * INSERT is where the two schemas were written apart, and it names the columns explicitly.
 */
/** Is the match at `index` on a line that opens the SQLite branch of a `db.isPostgres` ternary? */
function sqliteBranchOfTernary(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  return source.slice(lineStart, index).trimStart().startsWith(':');
}

function insertedColumns(file) {
  const re = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  const source = readFileSync(join(ROOT, file), 'utf8');
  const out = new Map();
  let m;
  while ((m = re.exec(source))) {
    // A dialect-aware statement is written as a ternary on `db.isPostgres`, so its SQLite branch
    // begins the line with `:`. That branch never runs on Postgres, and counting its column names as
    // things the app writes here reports a *fixed* mismatch as still broken -- which is how this
    // audit would start arguing for changes that reintroduce the bug. Same test the ratchet in
    // scripts/guards.js uses, for the same reason: a proximity window is not good enough.
    if (sqliteBranchOfTernary(source, m.index)) continue;
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
  const url = process.argv[2] || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('usage: node scripts/audit-postgres-schema-gap.js <postgres-url>');
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const { rows: colRows } = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  await client.end();
  const present = new Set(rows.map((r) => r.tablename));
  const columns = new Map();
  for (const r of colRows) {
    if (!columns.has(r.table_name)) columns.set(r.table_name, new Set());
    columns.get(r.table_name).add(r.column_name);
  }

  const refs = referencedTables('server.js');
  const missing = [...refs].filter(([t]) => !present.has(t)).sort();

  console.log(`server.js references ${refs.size} tables; ${present.size} exist in this database.\n`);
  if (!missing.length) {
    console.log('No gap: every table server.js touches exists here.');
    return;
  }

  const migrationFixes = [];
  const undefinedAnywhere = [];
  for (const [table, verbs] of missing) {
    const sites = definitionSites(table);
    const row = { table, verbs: [...verbs].sort().join(','), sites };
    if (sites.some((s) => s.endsWith('.sql'))) migrationFixes.push(row);
    else undefinedAnywhere.push(row);
  }

  if (migrationFixes.length) {
    console.log('MISSING, but a v2 migration already creates it (so: the migration has not run):');
    for (const r of migrationFixes) {
      console.log(`  ${r.table.padEnd(18)} ${r.verbs.padEnd(22)} ${r.sites.join(', ')}`);
    }
    console.log('');
  }
  if (undefinedAnywhere.length) {
    console.log('MISSING, and nothing creates it -- neither db.js nor any migration:');
    for (const r of undefinedAnywhere) {
      console.log(`  ${r.table.padEnd(18)} ${r.verbs}`);
    }
    console.log('');
  }
  console.log(`${missing.length} table(s) referenced but absent. Each is a dead feature on this database.`);
  reportColumns(columns, present);
}

/**
 * A table can exist and still be the wrong shape. `db.js` builds a different table for each dialect
 * under the same name -- `follows` has `following_id` on Postgres and `followed_id` on SQLite,
 * `collection_cards` has `foil` against `is_foil` -- and server.js writes the SQLite spelling. The
 * INSERT fails with `column "..." does not exist`, which a table-level check never sees.
 */
function reportColumns(columns, present) {
  const gaps = [];
  for (const [table, cols] of insertedColumns('server.js')) {
    if (!present.has(table)) continue; // the table check already covers this
    const have = columns.get(table) ?? new Set();
    const missing = [...cols].filter((c) => !have.has(c)).sort();
    if (missing.length) gaps.push([table, missing]);
  }
  if (!gaps.length) {
    console.log('\nEvery column server.js inserts exists on the tables that are present.');
    return;
  }
  console.log('\nCOLUMNS server.js inserts that do not exist (the table is there, the shape is not):');
  for (const [table, missing] of gaps.sort()) {
    console.log(`  ${table.padEnd(20)} ${missing.join(', ')}`);
  }
  console.log(`\n${gaps.reduce((n, [, m]) => n + m.length, 0)} column(s) missing across ${gaps.length} table(s).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
