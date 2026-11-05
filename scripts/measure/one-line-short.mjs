/**
 * Which **shape** is the last thing standing between a card and a finished script?
 *
 * `compilable.mjs` ranks the work queue by lines printed, which is the right question for "how much
 * of Magic is read" and the wrong one for "what to build next". A family of 90 lines whose cards
 * each have three other gaps finishes nothing; a shape printed by 67 cards that have **no other
 * unread line** finishes 67 cards. D438-D443 were picked off the lines-printed queue and moved
 * coverage about ten cards each. D444 was picked off this one and moved it 233.
 *
 * So this asks the same corpus a different question: of the cards that are **exactly one unread line
 * from finished**, what does that line look like? The shapes are grouped the way `compilable.mjs`
 * groups openings — name to `~`, mana symbols to `{M}`, numbers to `N` — but seven words rather than
 * five, because a mana ability and a damage spell share their first five.
 *
 * ## Reading it
 *
 * A row is a promise: read that shape and that many cards go from hybrid (D362: dealt with a flagged
 * line) to fully automated. It is a **ceiling**, not a forecast — the shape still has to be read
 * correctly, and some rows are a restriction nothing can express yet rather than a reader waiting to
 * be written ("Spend this mana only to cast a creature spell" is a row here and must stay unread).
 *
 *   node scripts/measure/one-line-short.mjs
 *   node scripts/measure/one-line-short.mjs --file /path/to/corpus.json
 *   TOP=40 node scripts/measure/one-line-short.mjs
 *   LEGAL=1 node scripts/measure/one-line-short.mjs --file …   # competitive formats only
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { poolRows } from '../lib/pool-rows.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';

const TOP = Number(process.env.TOP ?? 25);
const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];

/** The shape of a line, with its name, symbols and numbers taken out. See `compilable.mjs`. */
function shapeOf(line, name) {
  return line
    .replaceAll(name, '~')
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[^A-Za-z0-9{}~/+\- ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7)
    .join(' ');
}

const all = file === null
  ? poolRows()
  : JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;

console.log(`Source: ${file ?? 'the engine pool'}`);
console.log(`    ${provenanceLine()}`);
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

const buckets = new Map();
let read = 0;
let oneShort = 0;
let more = 0;
for (const row of rows) {
  let compiled;
  try {
    compiled = compileCard(row);
  } catch {
    continue;
  }
  if (!compiled.ok) continue;
  read += 1;
  if (compiled.unread.length === 0) continue;
  if (compiled.unread.length > 1) { more += 1; continue; }
  oneShort += 1;
  const key = shapeOf(compiled.unread[0].line, row.name ?? '');
  const bucket = buckets.get(key) ?? { count: 0, example: '' };
  bucket.count += 1;
  if (bucket.example === '') {
    bucket.example = `${row.name}: "${compiled.unread[0].line.slice(0, 110)}"`;
  }
  buckets.set(key, bucket);
}

console.log(`\nCards read: ${read}`);
console.log(`  one unread line from finished: ${oneShort}`);
console.log(`  two or more unread lines:      ${more}`);

const ranked = [...buckets].sort((a, b) => b[1].count - a[1].count);
const singles = ranked.filter(([, b]) => b.count === 1).length;
console.log(`\n${ranked.length} distinct shapes, ${singles} printed by a single card.`);
console.log(`The ${Math.min(TOP, ranked.length)} that would finish the most cards:`);
for (const [key, bucket] of ranked.slice(0, TOP)) {
  console.log(`  ${String(bucket.count).padStart(5)}  ${key}`);
  console.log(`         e.g. ${bucket.example}`);
}

console.log(`
A row is a CEILING, not a forecast: the shape still has to be read correctly, and
some rows are a restriction nothing can express yet rather than a reader waiting
to be written. "Spend this mana only to cast a creature spell" belongs here and
must stay unread (D444).`);
