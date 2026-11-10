/**
 * Writes the Oracle rows the built-in pool is checked against.
 *
 *   node scripts/measure/pool-oracle.mjs --file /path/to/corpus.json          # report only
 *   node scripts/measure/pool-oracle.mjs --file /path/to/corpus.json --write  # rewrite the fixture
 *
 * The fixture is `packages/rules-engine/src/poolOracle.fixture.json`, and the test that reads it is
 * `poolOracle.test.ts`. The corpus is the same JSON array `compilable.mjs --file` takes: a Scryfall
 * `oracle_cards` bulk file, or the rows `scripts/corpus/from-forge.mjs` builds. Both carry only the
 * **front** face of a two-faced card, so the back half of a split card and the Adventure half of an
 * adventurer have no row here — the test names those rather than passing them quietly.
 *
 * Why this exists (D571): the pool's 336 cards were typed in by hand over many sessions, and a
 * comparison against the corpus found 122 wrong costs, type lines and sizes and 95 rules texts that
 * differed in substance. Nothing had ever compared the two. Only the pool's card **names** are read
 * from the built engine here; the comparison itself is the test's, against source.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STARTER_DECKS } from '../lib/engine.mjs';

const args = process.argv.slice(2);
const fileAt = args.indexOf('--file');
if (fileAt < 0 || !args[fileAt + 1]) {
  console.error('usage: node scripts/measure/pool-oracle.mjs --file <corpus.json> [--write]');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(args[fileAt + 1], 'utf8'));
const byName = new Map();
for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row);

const fixturePath = fileURLToPath(new URL('../../packages/rules-engine/src/poolOracle.fixture.json', import.meta.url));

/** Every definition a deck can put on the table: its cards, its commander, and each nested face. */
const names = new Set();
const add = (def) => {
  names.add(def.name);
  for (const face of def.faces?.cards ?? []) add(face);
};
for (const deck of Object.values(STARTER_DECKS)) {
  if (deck.commander) add(deck.commander);
  for (const entry of deck.cards) add(entry.card);
}

const fixture = {};
const absent = [];
for (const name of [...names].sort()) {
  const row = byName.get(name);
  if (!row) { absent.push(name); continue; }
  fixture[name] = {
    manaCost: row.mana_cost ?? '',
    cmc: Number(row.cmc ?? 0),
    typeLine: row.type_line ?? '',
    oracleText: row.oracle_text ?? '',
    colors: [...(row.colors ?? [])].sort(),
    ...(row.power != null ? { power: String(row.power) } : {}),
    ...(row.toughness != null ? { toughness: String(row.toughness) } : {}),
    ...(row.loyalty != null ? { loyalty: String(row.loyalty) } : {}),
  };
}

console.log(`definitions in the pool: ${names.size}; with a corpus row: ${Object.keys(fixture).length}`);
console.log(`no corpus row (${absent.length}): ${absent.join(', ')}`);
if (args.includes('--write')) {
  // One card to a line, so a corrected card is a one-line diff.
  const lines = Object.entries(fixture).map(([name, row]) => ` ${JSON.stringify(name)}: ${JSON.stringify(row)}`);
  writeFileSync(fixturePath, `{\n${lines.join(',\n')}\n}\n`);
  console.log(`wrote ${fixturePath}`);
}
