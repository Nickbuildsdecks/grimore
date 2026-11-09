/*
  Which printed CLAUSE, if it read, would finish the most cards? Measured by compiling.

  `one-away.mjs` ranks whole unread LINES, which is an upper bound on what a reader finishes: a
  line is usually several clauses and a reader is usually one. D524 measured that bound at 2x-18x.
  The obvious fix — compile each clause on its own as a one-line sorcery and count the cards whose
  failing line has exactly one clause that will not — is what `scratchpad/p549.mjs` did, and it is
  wrong in a way that is worth writing down, because its head row read 39 and shipped 8 (D532).

  Two independent biases, and neither is small:

   1. **It never tests the prologue.** A trigger's clauses are what is left after "Whenever you
      gain life," comes off, so a card whose prologue has no `TRIGGER_SHAPE` counts as one clause
      short when it is two readers short. Every trigger row is inflated by however many of its
      cards are prologue-blocked — a different number for each row, so the ranking is not even
      uniformly wrong.
   2. **It compiles under a placeholder name.** `selfRef(name)` matches the card's own name, so
      "put a +1/+1 counter on Arcbound Crusher" fails under the name "Probe Card" for a reason
      that has nothing to do with the reader. Those artifacts took the whole head of that
      ranking (58, 37, 25, 16 …), and three separate probes in one session were fooled by it.

  This asks the question a reader actually answers. For each legal card that is exactly one line
  short, SUBSTITUTE each clause of that line in turn with a clause the compiler certainly reads,
  and recompile the whole card. If the card then reads whole, that clause is the only thing between
  this card and a finished script: the prologue reads, every sibling clause reads, and the card's
  own name is where it was printed. A clause that is the sole such blocker on its card is counted
  under its normalised shape, and the ranking is a queue ordered by cards finished (D434).

  Substitution rather than removal, and the difference is 9,459 cards: a line with one clause has
  nothing to remove but itself, so a removal test is silent on exactly the single-clause lines
  that most trigger printings are. Substituting keeps the clause count, so "Whenever you scry, put
  a +1/+1 counter on ~" is tested as "Whenever you scry, draw a card" — which reads if and only if
  the prologue does.

  The placeholder is **a clause and not a sentence**, so it composes wherever the printed one did.
  It cannot read a cost, a keyword or a quoted tail, so clauses in those positions are never
  reported as blockers — this instrument under-counts rather than over-counts, which is the
  direction a queue should err in.
*/
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { isLegal } from '../lib/legal.mjs';

const flag = process.argv.indexOf('--file');
const file = flag === -1 ? process.argv[2] : process.argv[flag + 1];
if (file === undefined || file.startsWith('--')) {
  console.error('usage: node scripts/measure/one-blocker.mjs [--file] <corpus.json> [--top N]');
  process.exit(2);
}
const topFlag = process.argv.indexOf('--top');
const TOP = topFlag === -1 ? 40 : Number(process.argv[topFlag + 1]);
const rows = JSON.parse(readFileSync(file, 'utf8')).filter(isLegal);

/** The clause the substitution puts in: short, unconditional, and read everywhere. */
const PLACEHOLDER = 'draw a card';

/** The same split `composeEffects` uses, so a "clause" here is a clause there. */
const clausesOf = (line) => line.split(/\.\s+/)
  .flatMap((s) => s.split(/,\s+then\s+/i))
  .map((c) => c.replace(/\.\s*$/, '').trim())
  .filter((c) => c !== '');

/** A clause as a comparable shape: the card's own name, numbers and costs generalised. */
const shapeOf = (clause, name) => clause
  .replaceAll(name, '~')
  .replace(/\b\d+\b/g, 'N')
  .replace(/\{[^}]+\}/g, '{M}')
  .toLowerCase()
  .slice(0, 72);

const shapes = new Map();
const examples = new Map();
const seen = new Set();
let scanned = 0;
let oneShort = 0;
let singleBlocker = 0;
let noneOrSeveral = 0;

for (const row of rows) {
  if (seen.has(row.name)) continue;
  seen.add(row.name);
  scanned += 1;
  const before = compileCard(row);
  if (!before.ok) continue;
  if (before.unread.length !== 1 || before.unread[0].why !== 'no-reader') continue;
  oneShort += 1;
  const line = before.unread[0].line;
  const clauses = clausesOf(line);
  const blockers = [];
  for (const clause of clauses) {
    if (clause === PLACEHOLDER) continue;
    const rebuilt = `${clauses.map((one) => (one === clause ? PLACEHOLDER : one)).join('. ')}.`;
    const text = (row.oracle_text ?? '').split('\n')
      .map((one) => (one === line ? rebuilt : one))
      .join('\n');
    if (text === (row.oracle_text ?? '')) continue;
    const after = compileCard({ ...row, oracle_text: text });
    if (after.ok && after.unread.length === 0) blockers.push(clause);
  }
  if (blockers.length !== 1) { noneOrSeveral += 1; continue; }
  singleBlocker += 1;
  const shape = shapeOf(blockers[0], row.name);
  shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  if (!examples.has(shape)) {
    examples.set(shape, `${row.name}: "${blockers[0].slice(0, 96)}"`);
  }
}

console.log(`legal cards scanned: ${scanned}`);
console.log(`exactly one no-reader line short: ${oneShort}`);
console.log(`  exactly ONE clause of it is the blocker: ${singleBlocker}`);
console.log(`  none, or several at once:                ${noneOrSeveral}`);
console.log('\n=== CARDS FINISHED BY ONE NEW CLAUSE READER ===');
for (const [shape, count] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`${String(count).padStart(4)}  ${shape}`);
  console.log(`        e.g. ${examples.get(shape)}`);
}
