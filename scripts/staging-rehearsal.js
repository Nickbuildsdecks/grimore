#!/usr/bin/env node
/**
 * The staging cutover rehearsal, in one script, runnable entirely on the VM.
 *
 * Why it exists in this shape: the production database is reachable from nowhere but the VM's own Docker
 * network (`docker-compose.yml` gives postgres `expose: "5432"`, not `ports:`), so no connection string
 * handed to a remote session can reach it. The answer is not to publish the database — it is to run the
 * read-only work where the database already is and move only the *output*.
 *
 * Nothing here writes to the database it is pointed at, with one exception that is named and opt-in:
 * `migrate` is refused unless the URL's database name contains "staging". A rehearsal that can be run
 * against production by a mistyped variable is not a rehearsal.
 *
 * Usage, all read-only unless stated:
 *
 *   node scripts/staging-rehearsal.js snapshot   "$URL"   # row-level fingerprint, to stdout as JSON
 *   node scripts/staging-rehearsal.js compare    before.json after.json
 *   node scripts/staging-rehearsal.js predict    "$URL"   # what migration 0013's dedupe WILL delete
 *   node scripts/staging-rehearsal.js guard      "$URL"   # prove a role cannot write
 */
const { readFileSync } = require('node:fs');

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  console.error('This needs the `pg` package. Run it inside a container that has it:');
  console.error('  docker exec -i grimore-app node scripts/staging-rehearsal.js <command> ...');
  process.exit(2);
}

/**
 * The tables migrations 0005 and 0009 rewrite, plus the one 0013 deduplicates.
 *
 * 0005 converts `collections.id` from an integer serial to text and converts
 * `collection_cards.collection_id` alongside it; 0009 drops the `player_stats` and `deck_stats` primary
 * keys and replaces them with partial unique indexes. Those are the one-way doors, so those are the rows
 * worth fingerprinting.
 */
const WATCHED = {
  collections: 'SELECT id::text AS id, player_id, name FROM collections ORDER BY id::text',
  collection_cards:
    "SELECT collection_id::text AS collection_id, card_name, quantity::text AS quantity, coalesce(foil::text,'') AS foil FROM collection_cards ORDER BY collection_id::text, card_name, coalesce(foil::text,'')",
  player_stats:
    "SELECT player_id, coalesce(season_id,'') AS season_id, coalesce(total_points::text,'') AS total_points FROM player_stats ORDER BY player_id, coalesce(season_id,'')",
  deck_stats:
    "SELECT deck_id, coalesce(season_id,'') AS season_id, coalesce(total_points::text,'') AS total_points FROM deck_stats ORDER BY deck_id, coalesce(season_id,'')",
};

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Every row of the watched tables, ordered deterministically, so two runs can be diffed exactly. */
async function snapshot(url) {
  const client = await connect(url);
  const out = { takenAt: new Date().toISOString(), tables: {} };
  try {
    for (const [table, sql] of Object.entries(WATCHED)) {
      try {
        const { rows } = await client.query(sql);
        out.tables[table] = { count: rows.length, rows };
      } catch (err) {
        // A table that does not exist yet is a fact about the schema, not a failure of the snapshot:
        // before the cutover several of these are absent, and recording that is the point.
        out.tables[table] = { error: err.message };
      }
    }
    const counts = await client.query(
      `SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS n
         FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    out.allTableCounts = Object.fromEntries(counts.rows.map((r) => [r.table_name, Number(r.n)]));
  } finally {
    await client.end();
  }
  return out;
}

/** Exactly what 0013's dedupe will delete, counted rather than estimated. */
async function predict(url) {
  const client = await connect(url);
  try {
    const dupes = await client.query(
      `SELECT lower(card_name) AS name, count(*) AS n FROM card_price_cache
        GROUP BY lower(card_name) HAVING count(*) > 1 ORDER BY count(*) DESC, lower(card_name)`,
    );
    const total = await client.query('SELECT count(*)::bigint AS n FROM card_price_cache');
    const willDelete = dupes.rows.reduce((sum, r) => sum + (Number(r.n) - 1), 0);
    return {
      card_price_cache_rows_now: Number(total.rows[0].n),
      names_with_duplicates: dupes.rows.length,
      rows_migration_0013_will_delete: willDelete,
      rows_after: Number(total.rows[0].n) - willDelete,
      worst_offenders: dupes.rows.slice(0, 10).map((r) => ({ name: r.name, copies: Number(r.n) })),
    };
  } finally {
    await client.end();
  }
}

/**
 * Prove a role cannot write. Every statement here is EXPECTED to be refused; a success is the finding.
 *
 * Wrapped in a transaction that is always rolled back, so even a role that turns out to have write
 * access leaves nothing behind.
 */
async function guard(url) {
  const client = await connect(url);
  const results = [];
  const probes = [
    ['INSERT', "INSERT INTO players (id, username, store_nickname, email, password_hash) VALUES ('probe_ro','probe_ro','P','p@probe.test','x')"],
    ['UPDATE', "UPDATE players SET store_nickname = 'probe' WHERE id = 'no_such_player'"],
    ['DELETE', "DELETE FROM players WHERE id = 'no_such_player'"],
    ['CREATE TABLE', 'CREATE TABLE readonly_probe_table (x integer)'],
    ['CREATE INDEX', 'CREATE INDEX readonly_probe_idx ON players (username)'],
    ['TRUNCATE', 'TRUNCATE card_price_cache'],
  ];
  try {
    const who = await client.query('SELECT current_user, current_database()');
    for (const [label, sql] of probes) {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        results.push({ probe: label, refused: false, note: 'SUCCEEDED — this role can write. Not read-only.' });
      } catch (err) {
        results.push({ probe: label, refused: true, error: err.message.split('\n')[0] });
      }
      await client.query('ROLLBACK');
    }
    // A read must still work, or the role is useless rather than safe.
    let canRead = false;
    try {
      await client.query('SELECT count(*) FROM players');
      canRead = true;
    } catch (err) {
      results.push({ probe: 'SELECT', refused: true, error: err.message.split('\n')[0] });
    }
    return {
      role: who.rows[0].current_user,
      database: who.rows[0].current_database,
      can_read: canRead,
      writes_all_refused: results.every((r) => r.refused),
      probes: results,
    };
  } finally {
    await client.end();
  }
}

/** Diff two snapshots row by row. */
function compare(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const report = [];
  let ok = true;
  for (const table of Object.keys(WATCHED)) {
    const b = before.tables[table];
    const a = after.tables[table];
    if (b?.error && a?.error) {
      report.push(`  ${table.padEnd(18)} absent before and after (${a.error.split('\n')[0]})`);
      continue;
    }
    if (b?.error) {
      report.push(`  ${table.padEnd(18)} CREATED by the migration (${a.count} rows) — nothing to preserve`);
      continue;
    }
    if (a?.error) {
      report.push(`  ${table.padEnd(18)} DISAPPEARED — ${a.error.split('\n')[0]}`);
      ok = false;
      continue;
    }
    const bj = JSON.stringify(b.rows);
    const aj = JSON.stringify(a.rows);
    if (bj === aj) {
      report.push(`  ${table.padEnd(18)} ${String(b.count).padStart(7)} rows, identical`);
    } else {
      ok = false;
      report.push(`  ${table.padEnd(18)} CHANGED: ${b.count} rows -> ${a.count} rows`);
      const bs = new Set(b.rows.map((r) => JSON.stringify(r)));
      const as = new Set(a.rows.map((r) => JSON.stringify(r)));
      const lost = [...bs].filter((r) => !as.has(r)).slice(0, 5);
      const gained = [...as].filter((r) => !bs.has(r)).slice(0, 5);
      for (const r of lost) report.push(`      lost:   ${r}`);
      for (const r of gained) report.push(`      gained: ${r}`);
    }
  }
  console.log('Watched tables (the ones 0005 and 0009 rewrite):');
  console.log(report.join('\n'));

  console.log('\nEvery table, row counts before -> after:');
  const names = new Set([...Object.keys(before.allTableCounts ?? {}), ...Object.keys(after.allTableCounts ?? {})]);
  for (const n of [...names].sort()) {
    const b = before.allTableCounts?.[n];
    const a = after.allTableCounts?.[n];
    const flag = b === undefined ? ' (new)' : a === undefined ? ' (GONE)' : b === a ? '' : '  <-- changed';
    console.log(`  ${n.padEnd(24)} ${String(b ?? '-').padStart(8)} -> ${String(a ?? '-').padStart(8)}${flag}`);
  }
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: the watched tables were ${ok ? 'preserved row for row' : 'NOT preserved — read the CHANGED lines above'}.`,
  );
  return ok ? 0 : 1;
}

async function main() {
  const [command, a, b] = process.argv.slice(2);
  if (command === 'compare') {
    if (!a || !b) {
      console.error('usage: staging-rehearsal.js compare <before.json> <after.json>');
      process.exit(2);
    }
    process.exit(compare(a, b));
  }
  const url = a || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!command || !url) {
    console.error('usage: staging-rehearsal.js <snapshot|predict|guard> <postgres-url>');
    console.error('       staging-rehearsal.js compare <before.json> <after.json>');
    process.exit(2);
  }
  if (command === 'snapshot') console.log(JSON.stringify(await snapshot(url), null, 2));
  else if (command === 'predict') console.log(JSON.stringify(await predict(url), null, 2));
  else if (command === 'guard') console.log(JSON.stringify(await guard(url), null, 2));
  else {
    console.error(`unknown command: ${command}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
