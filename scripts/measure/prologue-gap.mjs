/**
 * Which **trigger prologue**, if the compiler could read it, would finish the most cards?
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/prologue-gap.mjs --file corpus.json
 *   LEGAL=1 DUMP="whenever you cast" node scripts/measure/prologue-gap.mjs --file corpus.json
 *
 * ## Why this instrument exists
 *
 * D473 found that 425 of the 472 cards in the `you may X. If you do, Y` family are held up by the
 * **line around** the construct rather than by either half of it, and that the frame is almost
 * always a trigger prologue nothing can read. That is a claim about one family. This asks the same
 * question about the whole corpus: a line is `<prologue>, <effect>`, the clause vocabulary has had
 * seven increments of work (D465-D472) and the prologue vocabulary has had none since the shapes
 * `triggerShapeFor` was born with.
 *
 * ## The method is `phrase-gap.mjs`', and D473 is why it is not anything else
 *
 * **Substitution in place.** Leave the printed line as it is, replace the prologue with one known
 * to read — `When ~ enters,` — and ask the compiler whether the **whole line** now reads. Nothing
 * is reconstructed and no half is compiled in a position it never appears in, which is the mistake
 * that has now produced four wrong answers about this corpus (`may-halves.mjs`' 63, two artefacts
 * from a clause-level probe, and `may-if-you-do.mjs`' 402 — all retracted, D465 and D473).
 *
 * `finishes` is therefore a real ceiling for a prologue reader: the cards whose only unread line
 * would read if this prologue did, with the effect left exactly as printed.
 *
 * ## What a prologue is, here
 *
 * The leading clause of a line that ends in a comma and is followed by at least one more word:
 * `Whenever you cast an instant or sorcery spell,` / `At the beginning of your end step,` /
 * `Kinship — At the beginning of your upkeep,`. A line with no comma has no prologue and is
 * skipped; so is one whose prologue the compiler **already** reads, because substituting that
 * changes nothing and would count the card against a reader it does not need.
 *
 * ## `LEGAL=1`
 *
 * `isLegal` returns true for everything when `LEGAL` is unset, so a count taken without it is a
 * count of 33,847 rows including un-cards rather than 31,654 (D464).
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { poolRows } from '../lib/pool-rows.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';

const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];
const DUMP = (process.env.DUMP ?? '').toLowerCase();
const TOP = Number(process.env.TOP ?? 30);

/** A prologue this compiler has read since the trigger shapes were written. */
const KNOWN = 'When CARDNAME enters,';

/** Everything up to the first comma, when there is a comma with words after it. */
function prologueOf(line) {
  const at = line.indexOf(',');
  if (at === -1) return null;
  const head = line.slice(0, at + 1);
  const rest = line.slice(at + 1).trim();
  if (rest === '' || head.length > 120) return null;
  // A comma inside a cost or a list is not a prologue: "{1}{G}, {T}: …" and "Flying, first strike".
  if (head.includes(':') || /^\{/.test(head.trim())) return null;
  return { head, rest };
}

/** The shape of a prologue, for grouping: lower-cased, the card's own name and numbers blanked. */
function shapeOf(head, name) {
  return head.toLowerCase()
    .replaceAll(name.toLowerCase(), '~')
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[,.]$/, '')
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');
}

const all = file === null ? poolRows() : JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;

console.log(`Source: ${file ?? 'the engine pool'}`);
console.log(`    ${provenanceLine()}`);
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

const tally = new Map();
let oneShort = 0;
let withPrologue = 0;
let finished = 0;

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
  oneShort += 1;
  const split = prologueOf(unread[0].trim());
  if (split === null) continue;
  withPrologue += 1;
  /*
    The substitution, on the card's own text. The card's name is written into the stand-in so the
    prologue is about **this** permanent, which is what `triggerShapeFor` matches on.
  */
  const swapped = (row.oracle_text ?? '').split('\n')
    .map((printed) => (printed === unread[0]
      ? `${KNOWN.replace('CARDNAME', row.name)} ${split.rest}`
      : printed))
    .join('\n');
  let after;
  try {
    after = compileCard({ ...row, oracle_text: swapped });
  } catch {
    continue;
  }
  if (!after?.ok || (after.unread ?? []).length > 0) continue;
  finished += 1;
  const shape = shapeOf(split.head, row.name);
  const seen = tally.get(shape) ?? { finishes: 0, cards: [] };
  seen.finishes += 1;
  seen.cards.push(`${row.name}: ${unread[0].trim()}`);
  tally.set(shape, seen);
}

console.log(`\nCards one unread line short: ${oneShort}`);
console.log(`  of those, whose line has a prologue the compiler does not read: ${withPrologue}`);
console.log(`  of those, finished by substituting a prologue known to read: ${finished}\n`);
console.log('Prologue, substituted in place by "When ~ enters,":\n');
const ranked = [...tally].sort((a, b) => b[1].finishes - a[1].finishes);
for (const [shape, seen] of ranked.slice(0, TOP)) {
  console.log(`  ${String(seen.finishes).padStart(4)}  ${shape}`);
  console.log(`         e.g. ${seen.cards[0]}`);
}
console.log(`\n${ranked.length} distinct prologue shapes; the top ${Math.min(TOP, ranked.length)} are above.`);
const head = ranked.slice(0, 10).reduce((n, [, seen]) => n + seen.finishes, 0);
console.log(`The ten commonest account for ${head} of the ${finished}.`);

if (DUMP !== '') {
  for (const [shape, seen] of ranked) {
    if (!shape.includes(DUMP)) continue;
    console.log(`\n${seen.finishes} in "${shape}":`);
    for (const card of seen.cards) console.log(`  ${card}`);
  }
}
