/**
 * "you may X. If you do, Y" — which half is the gap, counted per half.
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/may-halves.mjs --file corpus.json
 *
 * ## Why this exists, and the two wrong answers it replaced
 *
 * `one-line-short.mjs` ranks unread shapes by cards finished, and its top row reads "Whenever ~
 * deals combat damage to a player", 199 cards. That looks like a trigger family and **is not one**:
 * probed under the card's own name, the prologue already reads. So do "At the beginning of your end
 * step", "At the beginning of combat on your turn" and "At the beginning of your upkeep, you may …".
 * What those rows have in common is the *effect*: `you may X. If you do, Y`.
 *
 * The second wrong answer was mine. Counting cards whose consequence reads **in isolation** gave 158
 * and called it a reader's yield. It is not: a card is finished only if **both** halves read, and
 * testing one half while assuming the other is the error D461 recorded — a probe that cannot see
 * what it did not substitute. Alesha, Who Smiles at Death has a prologue that reads and a
 * consequence that does not; Akoum Stonewaker has `Landfall —` in front and fails on the prologue.
 * Both were counted as wins.
 *
 * So this substitutes each half in turn against a half known to read:
 *
 *  * the **prologue**, with `draw a card.` as its consequence;
 *  * the **consequence**, under `Whenever <self> attacks,` — with the card's own name re-pointed at
 *    the probe's, so a self-referential consequence still reads (D461).
 *
 * ## RETRACTED: the 63 below is not a reader's yield either (D465)
 *
 * The third wrong answer off this family, and it is this file's. The table below measures the
 * **prologue** and the **consequence** and never substitutes **X**, the opener — so it counts cards
 * that are one gap away from being *two* gaps away. Probed in place by `phrase-gap.mjs`, X reads for
 * **0 of the 63**: `discard a card`, `sacrifice another creature`, `exile it` and `pay 2 life` are
 * each an unread clause in their own right, and `Whenever ~ attacks, discard a card.` does not read
 * either. **The yield of a free-`may` two-sentence reader alone is zero cards.**
 *
 * The error is the same shape as D461's, which this file's own docblock names two paragraphs above:
 * testing one part while assuming the rest. Naming it was not enough to avoid repeating it, because
 * the fix was partial — two of three parts instead of one of two. `phrase-gap.mjs` substitutes in
 * place and asks whether the **whole line** reads, which is the only form of this question that
 * cannot be answered by a reconstruction.
 *
 * The table is kept rather than deleted: the **split** it measures is still true and still useful
 * (the priced form reads 1 because it already has a reader, which a single count could not have
 * said). What is retracted is reading the 63 as a yield. For a yield, use `phrase-gap.mjs`.
 *
 * ## The reading at ee59e8a, over 31,654 legal cards
 *
 * Cards one unread line from finished, where that line has the shape:
 *
 * | | prologue | consequence | cards |
 * | --- | --- | --- | --- |
 * | free   | reads | reads | **63** |
 * | free   | reads | gap   | 106 |
 * | free   | gap   | gap   | 88 |
 * | free   | gap   | reads | 33 |
 * | priced | reads | reads | **1** |
 * | priced | reads | gap   | 56 |
 * | priced | gap   | gap   | 52 |
 * | priced | gap   | reads | 44 |
 *
 * **63 is NOT the yield of a free-`may` two-sentence reader** — see the retraction above; it is the
 * only bucket such a reader *could* finish, and it finishes none of them, because the opener this
 * table never substituted is unread in all 63. The priced bucket reads 1 because `you may pay {M}. If you do, Y` **already has a
 * reader**; its one-line-short cards are held up by their prologues and consequences instead,
 * which is what the split says and a single count could not.
 *
 * ## And a construct this found by accident: `When you do,` — 155 cards
 *
 * Ancestral Katana: "Whenever a Samurai or Warrior you control attacks alone, you may pay {1}.
 * **When** you do, attach Ancestral Katana to it." That is a **reflexive trigger** (CR 603.12), not a
 * conditional clause: paying is an event, and the consequence triggers off it rather than following
 * it in the same resolution. The difference is visible at a table — a reflexive trigger uses the
 * stack and can be responded to — so reading it as `If you do,` would be a wrong reading, which
 * D362 ranks below leaving the line unread. **145 legal cards** print it, which makes it the largest
 * single family this instrument can see and its own increment rather than a rider here.
 *
 * ## `LEGAL=1`, which this file hard-earned the right to insist on
 *
 * `isLegal` reads `process.env.LEGAL` and **returns true for everything when it is unset**. So an
 * inline probe that forgets it silently measures all 33,847 rows, un-cards included, and reads high:
 * this family's first two figures were 66 and 155 that way, against the 63 and 145 above. The same
 * slip produced 187 free repeatable abilities against `free-abilities.mjs`' 176 (D464), in the same
 * session. Twice is a trap, not a mistake: **a count taken without `LEGAL=1` is a count of a
 * different corpus**, and the eleven or ten cards it adds are `Unicycle` and its friends — exactly
 * what the goal's "no uncards" excludes. Every figure quoted here is taken through this file, with
 * the filter line printed above it, for that reason.
 *
 * ## The rules hazard in the 66, which a reader has to answer first
 *
 * "If you do" means the consequence happens only if the first thing **actually happened**. A free
 * opener the player chose usually does happen — but "you may discard a card. If you do, draw a
 * card." with an empty hand is a case where it cannot, and a reader that gates only on the player's
 * yes would draw anyway. That is a wrong reading in an edge case rather than an unread line, so the
 * reader wants the option refused when the opener is impossible, not merely asked.
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const at = process.argv.indexOf('--file');
const file = at === -1 ? null : process.argv[at + 1];
if (file === null) {
  console.error('usage: LEGAL=1 node scripts/measure/may-halves.mjs --file corpus.json');
  process.exit(2);
}
console.log(`Source: ${file}`);
console.log(`    ${provenanceLine()}`);

const all = JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

const PROBE = 'Probe Beast';
const reads = (text) => compileCard({
  name: PROBE, type_line: 'Creature — Human', mana_cost: '{2}{G}', cmc: 3, colors: ['G'],
  power: '2', toughness: '2', loyalty: null, layout: 'normal', oracle_text: text,
}).compiled.length > 0;
const memo = new Map();
const cached = (text) => {
  if (!memo.has(text)) memo.set(text, reads(text));
  return memo.get(text);
};

const tally = new Map();
const examples = new Map();
let reflexive = 0;
for (const row of rows) {
  let compiled;
  try { compiled = compileCard(row); } catch { continue; }
  if (!compiled.ok || (compiled.unread ?? []).length !== 1) continue;
  // The card's own name re-pointed at the probe's, so a self-referential half still reads (D461).
  const line = compiled.unread[0].line
    .replace(new RegExp(row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), PROBE);
  if (/\bWhen you do,/i.test(line)) { reflexive += 1; continue; }
  const m = /^(.*?,\s*)you may ([^.]+)\.\s*If you do,\s*(.+)$/i.exec(line);
  if (m === null) continue;
  const prologueOk = cached(`${m[1]}draw a card.`);
  const consequenceOk = cached(`Whenever ${PROBE} attacks, ${m[3]}`);
  const key = `${/^pay \{/i.test(m[2]) ? 'priced' : 'free  '}  prologue:${prologueOk ? 'reads' : 'gap  '}`
    + `  consequence:${consequenceOk ? 'reads' : 'gap  '}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  if (!examples.has(key)) examples.set(key, `${row.name}: ${compiled.unread[0].line.slice(0, 110)}`);
}

console.log('\nCards one unread line from finished, by which half is the gap:\n');
for (const [key, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${key}`);
  console.log(`      e.g. ${examples.get(key)}`);
}
console.log(`\n"When you do," — a reflexive trigger (CR 603.12), a different construct: ${reflexive}`);
console.log('The only bucket a reader for this shape finishes is free/reads/reads.');
