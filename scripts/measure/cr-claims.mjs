/**
 * Which **rules does the engine claim in a comment** and no test write down?
 *
 *   node scripts/measure/cr-claims.mjs
 *   LIMIT=40 node scripts/measure/cr-claims.mjs
 *
 * Three of four bugs found in one morning were found the same way: a comment claimed a rule the
 * code did not have. Etched Champion's docblock listed all four clauses of protection — "cannot be
 * blocked by, targeted by, dealt damage by, **enchanted by**" — while the state-based action
 * enforced three (#284). Thicket Basilisk's said "no `destroy` of a creature that has left …
 * which is the rule rather than a guard", which was true only of a card that left and *stayed*
 * gone, and a blink made it false twice over (#285, #286). D306 put it in a sentence: **a comment
 * claiming a rule is worth no more than a test asserting it** — and that sentence is a thing a
 * script can go looking for.
 *
 * So: every `CR <number>` in the engine's own sources, every one in its tests, and the rules that
 * appear only on the first list.
 *
 * **It finds claims with no matching citation, which is not the same as defects, and the
 * difference matters enough to be the first thing printed.** A test can assert a rule perfectly
 * well without writing its number down — the legend rule has six of them and cites itself once —
 * and a comment can mention a rule in passing while the real work is somewhere else. What the
 * list is for is *reading*: each row is a claim somebody wrote down and nobody wrote a test
 * against, and the three bugs above were all sitting in rows like these.
 *
 * Ranked by how many places claim the rule, because a rule asserted in four comments and no test
 * is a rule the engine is leaning on.
 *
 * **Why the engine only.** `apps/` and the measure scripts cite rules too, but a rule is
 * implemented in `packages/rules-engine` or nowhere, and a UI comment explaining why a button is
 * greyed out is not a claim about behaviour this can check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'packages/rules-engine/src';
const LIMIT = Number(process.env.LIMIT ?? 25);

/*
  "CR 704.5m", "CR 400.7", "CR 702.103c" — the citation style this codebase uses, and the only one
  it uses. A rule number is digits, dots and an optional trailing letter; the `CR` prefix is what
  makes it a citation rather than a version number or a count.
*/
const CITE = /\bCR\s+(\d+(?:\.\d+)*[a-z]?)/g;

const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const isTest = (f) => f.endsWith('.test.ts') || f === 'testkit.ts';

/** rule -> [{ file, line, text }] */
const claims = new Map();
const tested = new Map();

for (const file of files) {
  const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
  const into = isTest(file) ? tested : claims;
  lines.forEach((text, i) => {
    for (const match of text.matchAll(CITE)) {
      const rule = match[1];
      const where = into.get(rule) ?? [];
      where.push({ file, line: i + 1, text: text.trim() });
      into.set(rule, where);
    }
  });
}

const unasserted = [...claims]
  .filter(([rule]) => !tested.has(rule))
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

const claimed = [...claims.keys()].length;
console.log(`${claimed} rules cited in ${SRC} (non-test), ${tested.size} cited by its tests.`);
console.log(`${unasserted.length} are claimed by a comment and written down by no test.\n`);
console.log('A row is a claim to read, not a defect: a test can assert a rule without citing it.');
console.log('What the row says is that nobody wrote the number down beside an assertion.\n');

for (const [rule, where] of unasserted.slice(0, LIMIT)) {
  console.log(`CR ${rule}  (${where.length} claim${where.length === 1 ? '' : 's'})`);
  for (const w of where.slice(0, 3)) {
    const text = w.text.length > 96 ? `${w.text.slice(0, 93)}…` : w.text;
    console.log(`    ${w.file}:${w.line}  ${text}`);
  }
  if (where.length > 3) console.log(`    … and ${where.length - 3} more`);
}
if (unasserted.length > LIMIT) {
  console.log(`\n… and ${unasserted.length - LIMIT} more rules. LIMIT=${unasserted.length} for all.`);
}
