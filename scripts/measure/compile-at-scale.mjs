/**
 * Does the compiler survive a corpus, and how fast does it go?
 *
 * `compilable.mjs` asks how *much* of a card's text becomes rules. This asks a different question
 * that nothing has ever asked: the compiler has only ever been run over **348 rows**, and #318 will
 * hand it tens of thousands. A reader that is correct on 348 cards and throws on the 9,000th, or
 * that holds every compilation in memory until the process dies, fails at exactly the moment the
 * corpus arrives — and finding that out then is finding it out in the worst place.
 *
 * ## What it does not claim
 *
 * **No coverage figure from this script means anything.** The `--shuffled` arm builds rows whose
 * text is real printed lines recombined across cards, which is not any real card, so a share
 * measured on it is a share of nothing. Inventing the text of a real card is worse than leaving the
 * mechanic out (D259) and that rule is not weakened here: nothing this script produces is ever
 * turned into a shipped script, and the only numbers it reports are about **pace, memory and
 * crashes**. The share is printed by `compilable.mjs`, against real cards, and nowhere else.
 *
 * ## The two arms, and why both
 *
 * - **`--repeat N` (default).** The pool's 348 real rows, cloned N times with distinct names. Every
 *   row is a real card's real text, so this measures the pace and the memory of compiling a corpus
 *   and nothing else. It cannot find a crash on a line combination the pool does not contain.
 * - **`--shuffled`.** Each row takes a handful of printed lines sampled from the whole pool's line
 *   corpus, with the owning card's name rewritten to the row's own name so self-references still
 *   resolve. This is the crash hunt: a real corpus puts lines beside each other that the pool never
 *   does, and this does the same thing deliberately.
 *
 * ## Is the hunt able to fail?
 *
 * A crash hunt that reports zero is worth exactly as much as the proof that it could have reported
 * one, so the throw path was tested by planting one. A `throw` was put inside the anthem reader in
 * `scripts.ts`, the engine rebuilt, and the shuffled arm run again: **14 throws over 3,000 rows**,
 * each printed with the row that caused it. Narrowing the plant to a bonus the pool never prints
 * (`+2/+2`) reported zero, which is the same false green a real reader would give if nothing ever
 * reached it — so the first plant had to be the unconditional one. `compileCard` therefore does not
 * swallow a reader's throw, and a zero on this arm is a fact about the readers rather than about the
 * harness. The plant was reverted; it is recorded here because the next person to read a zero here
 * deserves to know it was checked rather than assumed.
 *
 *     node scripts/measure/compile-at-scale.mjs
 *     node scripts/measure/compile-at-scale.mjs --rows 60000
 *     node scripts/measure/compile-at-scale.mjs --shuffled --rows 60000 --seed 7
 */
import { compileCard } from '../lib/engine.mjs';
import { poolRows } from '../lib/pool-rows.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1]);
};
const ROWS = flag('rows', 30_000);
const SEED = flag('seed', 1);
const SHUFFLED = argv.includes('--shuffled');

/** The same small deterministic generator the engine's own shuffles use the shape of. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const POOL = poolRows();

/**
 * Every printed rules line in the pool, with the card it came from.
 *
 * Kept with its owner because a line is written about a particular card — "Thermo-Alchemist deals 1
 * damage to each opponent" names itself — so moving it to another card means rewriting that name,
 * which is what `lineFor` does. Without that the self-reference would point at a card that is not
 * there and every such line would read as unreadable, which would make the arm measure nothing.
 */
const LINES = POOL.flatMap((row) => String(row.oracle_text ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => ({ line, owner: row.name })));

const lineFor = (entry, name) => entry.line.split(entry.owner).join(name);

function rowsToCompile() {
  const out = [];
  if (!SHUFFLED) {
    for (let i = 0; i < ROWS; i += 1) {
      const row = POOL[i % POOL.length];
      // A distinct name per row, so nothing downstream can answer from a cache keyed on the name.
      out.push({ ...row, name: `${row.name} #${Math.floor(i / POOL.length)}` });
    }
    return out;
  }
  const next = rng(SEED);
  for (let i = 0; i < ROWS; i += 1) {
    const shape = POOL[Math.floor(next() * POOL.length)];
    const name = `Synthetic ${i}`;
    const count = 1 + Math.floor(next() * 4);
    const picked = [];
    for (let k = 0; k < count; k += 1) {
      picked.push(lineFor(LINES[Math.floor(next() * LINES.length)], name));
    }
    out.push({ ...shape, name, oracle_text: picked.join('\n') });
  }
  return out;
}

const rows = rowsToCompile();

const before = process.memoryUsage().rss;
const started = process.hrtime.bigint();
const bySource = new Map();
/** The first three throws, kept whole: the row that caused one is the bug report. */
const throws = [];
let throwsCount = 0;
let compiledLines = 0;
let unreadLines = 0;
let refused = 0;

for (const row of rows) {
  try {
    const result = compileCard(row);
    if (!result.ok) { refused += 1; continue; }
    bySource.set(result.source, (bySource.get(result.source) ?? 0) + 1);
    compiledLines += result.compiled.length;
    unreadLines += result.unread.length;
  } catch (err) {
    /*
      The whole point of the script. `compileCard` is documented as refusing with `ok: false` rather
      than throwing, so a throw here is a defect in a reader and not a rejected card — counted
      separately from `refused` for exactly that reason, and the first three are printed with their
      rows because the row is the bug report.
    */
    throwsCount += 1;
    if (throws.length < 3) {
      throws.push({ row, message: err instanceof Error ? err.message : String(err) });
    }
  }
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
const after = process.memoryUsage().rss;

console.log(`Arm: ${SHUFFLED ? 'shuffled (synthetic text, crash hunt)' : 'repeat (real text)'}`);
console.log(`    ${provenanceLine({ ROWS, SEED, SHUFFLED })}`);
console.log(`Rows compiled: ${rows.length}`);
console.log(`Throws: ${throwsCount}`);
for (const t of throws) {
  console.log(`  ${t.message}`);
  console.log(`    name=${JSON.stringify(t.row.name)} text=${JSON.stringify(t.row.oracle_text)}`);
}
console.log(`Refused as not a single-face card: ${refused}`);
console.log('');
console.log('By source:');
for (const [source, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${source.padEnd(14)} ${String(n).padStart(7)}`);
}
console.log('');
console.log(`Pace: ${elapsedMs.toFixed(0)} ms for ${rows.length} rows` +
  ` = ${(rows.length / (elapsedMs / 1000)).toFixed(0)} rows/s`);
console.log(`RSS: ${(before / 1e6).toFixed(0)} MB before, ${(after / 1e6).toFixed(0)} MB after` +
  ` (+${((after - before) / 1e6).toFixed(0)} MB)`);
console.log(`Lines: ${compiledLines} compiled, ${unreadLines} unread` +
  `${SHUFFLED ? ' — MEANINGLESS on this arm, the text is not any real card' : ''}`);
