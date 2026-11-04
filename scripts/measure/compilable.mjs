/**
 * How much of each card's printed text becomes rules, and **which lines do not**?
 *
 * The sibling of `derivable.mjs`, asking the question one level down. `derivable.mjs` counts cards
 * whose text is *nothing but* their data — an all-or-nothing verdict, 15% of the pool. This counts
 * **lines**, because that is the number that moves as the compiler grows and the number that says
 * what to build next.
 *
 * A card with four printed lines of which three compile is 75% here and a refusal there. Hybrid
 * automation (D362) is what makes that worth knowing: the card is dealt into an automated game with
 * its unread line flagged, so three quarters of it running is three quarters of a card, not nothing.
 *
 * ## What it prints
 *
 * 1. **Cards by source** — how each card's script was arrived at: `whole-card` (`cardFromData` read
 *    all of it), `lines` (this compiler read some of its lines), `printed-only` (it read none).
 * 2. **Lines compiled**, as a share of every printed rules line in the set. The headline.
 * 3. **The unread lines, grouped by what they open with, counted, with an example** — which is the
 *    work queue. A flat list of several thousand sentences is unreadable; "412 cards print a line
 *    opening *When ~ enters the battlefield, you gain*" is a morning's work with a known payoff.
 *
 * ## The two arms
 *
 * - **`pool` (default).** The engine's own 348 cards read back as rows. Thirteen decks built by hand
 *   to exercise sixty mechanics, so it is far heavier in paragraph cards than a list somebody plays:
 *   read the share as a **floor**. It is also the only arm with a hand-written script to check the
 *   compiler against, which is what `compile.test.ts` does.
 * - **`--file <path>`.** A Scryfall `oracle_cards` bulk JSON, which answers the question for all of
 *   Magic. Needs the import from D329 run on a machine that can reach Scryfall.
 *
 *   node scripts/measure/compilable.mjs
 *   node scripts/measure/compilable.mjs --file /path/to/oracle-cards.json
 *   TOP=40 node scripts/measure/compilable.mjs      # more of the work queue
 *   VERBOSE=1 node scripts/measure/compilable.mjs   # every card and its unread lines
 */
import { readFileSync } from 'node:fs';
import { STARTER_DECKS, compileCard } from '../lib/engine.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const VERBOSE = process.env.VERBOSE === '1';
const TOP = Number(process.env.TOP ?? 25);
const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];

/**
 * The pool read back as rows.
 *
 * A `CardDef` carries what a card prints, which is what a row carries, so this is a rename rather
 * than a conversion. The one field it cannot supply is `produced_mana`, so the land cross-check
 * inside `cardFromData` does not run on this arm — stated here rather than left to be found, since
 * it makes this arm slightly more permissive about lands than a real import would be.
 */
function poolRows() {
  const seen = new Map();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) if (!seen.has(entry.card.name)) seen.set(entry.card.name, entry.card);
    if (deck.commander && !seen.has(deck.commander.name)) seen.set(deck.commander.name, deck.commander);
  }
  return [...seen.values()].map((def) => ({
    name: def.name,
    type_line: def.typeLine,
    oracle_text: def.oracleText,
    mana_cost: def.manaCost,
    cmc: def.cmc,
    colors: [...def.colors],
    power: def.power ?? null,
    toughness: def.toughness ?? null,
    loyalty: def.loyalty ?? null,
    layout: def.faces === undefined ? 'normal' : def.faces.kind,
  }));
}

/**
 * What a line opens with, for grouping.
 *
 * Five words, with the card's own name replaced by `~` and numbers by `N`, so "Lightning Bolt deals
 * 3 damage to any target" and "Shock deals 2 damage to any target" land in one bucket. The same
 * normalisation `derivable.mjs` uses, for the same reason: the shape of a sentence is what a reader
 * would be written for, and the name and the number are its arguments.
 */
function opening(line, name) {
  return line
    .replaceAll(name, '~')
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[^A-Za-z0-9{}~/+\- ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

const rows = file === null ? poolRows() : (() => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
})();

console.log(`Source: ${file === null ? "the engine's own pool (13 decks)" : file}`);
console.log(`  ${provenanceLine({ FILE: file ?? '', TOP: String(TOP), VERBOSE: VERBOSE ? '1' : '' })}`);
console.log(`Cards read: ${rows.length}\n`);

const bySource = new Map();
const buckets = new Map();
let compiledLines = 0;
let unreadLines = 0;
let refused = 0;
const refusals = new Map();

for (const row of rows) {
  const result = compileCard(row);
  if (!result.ok) {
    refused += 1;
    const key = result.why.replace(/^[^:]*: /, '');
    refusals.set(key, (refusals.get(key) ?? 0) + 1);
    continue;
  }
  bySource.set(result.source, (bySource.get(result.source) ?? 0) + 1);
  compiledLines += result.compiled.length;
  unreadLines += result.unread.length;
  for (const { line, why } of result.unread) {
    const key = `${opening(line, result.def.name)}${why === 'field-conflict' ? '  [conflict]' : ''}`;
    const bucket = buckets.get(key) ?? { count: 0, example: `${result.def.name}: "${line}"` };
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  if (VERBOSE && result.unread.length > 0) {
    console.log(`  ${result.def.name} (${result.source}): ${result.unread.map((u) => u.line).join(' | ')}`);
  }
}

const cards = rows.length - refused;
console.log('Cards by how their script was arrived at:');
for (const source of ['whole-card', 'lines', 'printed-only']) {
  const n = bySource.get(source) ?? 0;
  console.log(`  ${source.padEnd(13)} ${String(n).padStart(6)}  ${(100 * n / cards).toFixed(1).padStart(5)}%`);
}
if (refused > 0) {
  console.log(`\nNot a single-face card at all: ${refused}`);
  for (const [why, n] of [...refusals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${why}`);
  }
}

const total = compiledLines + unreadLines;
console.log(`\nLines compiled: ${compiledLines} of ${total} (${(100 * compiledLines / total).toFixed(1)}%)`);
console.log(`Lines nothing could read: ${unreadLines}`);

const ranked = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
const singles = ranked.filter(([, b]) => b.count === 1).length;
console.log(`\nThe work queue: ${ranked.length} distinct openings, ${singles} printed by a single card.`);
console.log(`The ${Math.min(TOP, ranked.length)} most common:`);
for (const [key, bucket] of ranked.slice(0, TOP)) {
  console.log(`  ${String(bucket.count).padStart(5)}  ${key}`);
  console.log(`         e.g. ${bucket.example}`);
}

if (file === null) {
  console.log(`
This is the engine's own pool: thirteen decks built by hand to exercise sixty
mechanics, so it is far heavier in cards whose text is a paragraph than a list
somebody plays. Read the share above as a FLOOR. For the real figure, run the
Scryfall import (see claude/play-realm-setup.md) and pass --file.`);
}
