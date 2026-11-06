/*
  Which printed shape, if it read, would finish the most cards?

  Twice now I have ranked work by lines printed and been wrong — the graveyard mana-value block
  prints ~91 lines and finishes one card. D434 says rank by cards finished; this measures that
  directly and needs no per-family swap logic, so it cannot over-count the way the clause-queue
  ranking did (it replaced whole clauses including their destinations).

  Imported through `../lib/engine.mjs` rather than from `dist` directly, which `scripts/guards.js`
  enforces and which this instrument needs more than most: it reports which shape to build next, so
  a number about the *previous* build would send the next increment at the wrong family. D338 is the
  precedent — a measure printed the pre-change share, to a tenth of a percent, off a stale `dist`.

  The method: a card with exactly ONE unread line is **one shape away** from compiling completely,
  and that line is what blocks it. Normalise the line into a shape and count the cards. The answer
  is a queue ordered by what each family would actually finish.
*/
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { isLegal } from '../lib/legal.mjs';
/*
  `--file <path>`, or the path as a bare argument.

  It took `process.argv[2]` alone, which every sibling in this directory does not: `compilable.mjs`
  and `corpus-decks.mjs` both read `--file`. Running this with the flag the others take gave
  `ENOENT: open '--file'` — a harness whose calling convention differs from its neighbours' is a
  harness that gets called wrongly, so it takes both.
*/
const flag = process.argv.indexOf('--file');
const file = flag === -1 ? process.argv[2] : process.argv[flag + 1];
if (file === undefined || file.startsWith('--')) {
  console.error('usage: node scripts/measure/one-away.mjs [--file] <corpus.json>');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(file, 'utf8')).filter(isLegal);

/** A printed line as a comparable shape: the card's own name, numbers and costs generalised. */
const shapeOf = (line, name) => line
  .replaceAll(name, '~')
  .replace(new RegExp(`\\b${(name.split(',')[0] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '~')
  .replace(/\{[^}]*\}/g, '{M}')
  .replace(/\b\d+\b/g, 'N')
  .replace(/[“”"']/g, '')
  .trim()
  .split(/\s+/)
  .slice(0, 14)
  .join(' ');

const oneAway = new Map();   // shape -> { cards, eg }
const seen = new Set();
let total = 0; let oneLineCards = 0;
for (const row of rows) {
  if (seen.has(row.name)) continue;
  seen.add(row.name);
  let out; try { out = compileCard(row); } catch { continue; }
  if (!out.ok) continue;
  total += 1;
  if (out.unread.length !== 1) continue;
  oneLineCards += 1;
  const shape = shapeOf(out.unread[0].line, row.name);
  if (!oneAway.has(shape)) oneAway.set(shape, { cards: 0, eg: [] });
  const slot = oneAway.get(shape);
  slot.cards += 1;
  if (slot.eg.length < 3) slot.eg.push(row.name);
}

console.log(`distinct legal cards that compile: ${total}`);
console.log(`of those, exactly one unread line:  ${oneLineCards}`);
console.log(`distinct blocking shapes:           ${oneAway.size}`);
console.log('\nThe queue, by cards each shape would finish:\n');
for (const [shape, s] of [...oneAway].sort((a, b) => b[1].cards - a[1].cards).slice(0, 30)) {
  console.log(`${String(s.cards).padStart(4)}  ${shape}`);
  console.log(`      eg ${s.eg.join(' / ')}`);
}
