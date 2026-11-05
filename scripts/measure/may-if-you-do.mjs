/**
 * `you may X. If you do, Y` — which **half** is holding each card up, substituted in place.
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/may-if-you-do.mjs --file corpus.json
 *   LEGAL=1 DUMP="the opener" node scripts/measure/may-if-you-do.mjs --file corpus.json
 *
 * ## The first version of this file got its own biggest number wrong (D473)
 *
 * It compiled each half **as a bare clause** under a probe prologue — `When ~ enters, pay {2}.` —
 * and reported **402 of 472** cards blocked by the opener, which D472's entry then quoted as "the
 * real finding". It is an artefact. `pay {2}` is not a clause this compiler reads and never needs
 * to be: it is read by the *construct's* own reader, and has been since D448. So 146 of those 402
 * are mana and energy payments whose openers were never the problem.
 *
 * That is the third time this family has been mismeasured by asking about a half in a position the
 * half never appears in — `may-halves.mjs` (63, retracted D465) and `phrase-gap.mjs`' own docblock
 * list the other two — and the method that survives is the one `phrase-gap.mjs` settled on:
 * **substitution in place.** Leave the printed line exactly as it is, replace ONE half with
 * something known to read in that position, and ask the compiler whether the whole line reads.
 *
 * So, for every legal card one unread line short whose line is this construct:
 *
 *  - **the opener** — substitute X with `pay {1}`; if the line now reads, X was the blocker.
 *  - **the consequence** — substitute Y with `draw a card`; if the line now reads, Y was.
 *  - **either** — both substitutions read, so either half alone finishes the card.
 *  - **the line around them** — neither reads: the prologue, or a clause beside the construct.
 *
 * A card counts in exactly one bucket, and the buckets are a build order rather than a ranking.
 *
 * ## `LEGAL=1`
 *
 * `isLegal` returns true for everything when `LEGAL` is unset, so a count taken without it is a
 * count of 33,847 rows including un-cards rather than 31,654 (D464). Every figure quoted from this
 * script is taken with the filter line printed above it.
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { poolRows } from '../lib/pool-rows.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';

const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];
const DUMP = process.env.DUMP ?? '';

/** Known to read **in the opener's position**: the priced form has been read since D448. */
const KNOWN_X = 'pay {1}';
/** Known to read as a consequence, and the commonest one printed (96 of the 472). */
const KNOWN_Y = 'draw a card';

const memo = new Map();
/** Does this whole printed line read, on the card that prints it? */
function reads(row, line) {
  const key = `${row.name}\u0000${line}`;
  if (!memo.has(key)) {
    let ok = false;
    try {
      const swapped = (row.oracle_text ?? '').split('\n')
        .map((printed) => (printed === line.original ? line.text : printed)).join('\n');
      const compiled = compileCard({ ...row, oracle_text: swapped });
      ok = compiled.ok && (compiled.unread ?? []).length === 0;
    } catch {
      ok = false;
    }
    memo.set(key, ok);
  }
  return memo.get(key);
}

const all = file === null ? poolRows() : JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;

console.log(`Source: ${file ?? 'the engine pool'}`);
console.log(`    ${provenanceLine()}`);
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

/** `<prologue> you may <X>. If you do, <Y>`, with the prologue optional. */
const SHAPE = /^(.*?)\byou may ([^.]+)\.\s*if you do,\s*(.+?)\.?$/i;
const buckets = new Map([
  ['the opener', []],
  ['the consequence', []],
  ['either half alone', []],
  ['the line around them', []],
]);

let oneShort = 0;
for (const row of rows) {
  let compiled;
  try {
    compiled = compileCard(row);
  } catch {
    continue;
  }
  if (!compiled?.ok) continue;
  const unread = (compiled.unread ?? []).map((u) => u.line);
  if (unread.length !== 1) continue;
  const original = unread[0];
  const match = SHAPE.exec(original.trim());
  if (match === null) continue;
  oneShort += 1;
  const [, prologue, x, y] = match;
  const withX = `${prologue}you may ${KNOWN_X}. If you do, ${y}`;
  const withY = `${prologue}you may ${x.trim()}. If you do, ${KNOWN_Y}.`;
  const xFixed = reads(row, { original, text: withX });
  const yFixed = reads(row, { original, text: withY });
  const where = xFixed && yFixed ? 'either half alone'
    : xFixed ? 'the opener'
      : yFixed ? 'the consequence'
        : 'the line around them';
  buckets.get(where).push(`${row.name}: you may ${x.trim()}. If you do, ${y.trim()}.`
    + (prologue.trim() === '' ? '' : `   [after: ${prologue.trim()}]`));
}

console.log(`\nCards one unread line short whose line is this construct: ${oneShort}`);
console.log('Which half, substituted in place, makes the whole line read:\n');
for (const [key, cards] of buckets) {
  console.log(`  ${String(cards.length).padStart(4)}  ${key}`);
  if (cards.length > 0) console.log(`         e.g. ${cards[0]}`);
}
console.log('\n"either half alone" is the only bucket a single reader finishes on its own;');
console.log('the other two name which vocabulary to grow, and the last one is not this family.');

if (buckets.has(DUMP)) {
  const cards = buckets.get(DUMP);
  console.log(`\n${cards.length} in "${DUMP}":`);
  for (const line of cards) console.log(`  ${line}`);
}
