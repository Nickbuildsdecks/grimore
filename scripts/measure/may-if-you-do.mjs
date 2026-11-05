/**
 * `you may X. If you do, Y` — the yield of reading it as what it **means**.
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/may-if-you-do.mjs --file corpus.json
 *   LEGAL=1 DUMP="X asks once, Y asks nothing" node scripts/measure/may-if-you-do.mjs --file corpus.json
 *
 * ## Why this is not `phrase-gap.mjs`' row
 *
 * `phrase-gap.mjs` prices this construct by substituting the whole thing with **Y** — "you may
 * sacrifice a creature. If you do, draw a card" becomes "draw a card" — and its own docblock says
 * that figure is a ceiling rather than a reading: a reader must refuse Y when X was not performed
 * (CR 608.2), and `may-halves.mjs` already had to retract a number for measuring halves that are not
 * what a reader would build (D465).
 *
 * This asks the narrower question a real reader can answer. For every legal card **one unread line
 * short** of a finished script, where that line is this construct:
 *
 *  - does **X** read on its own, as a clause under a trigger prologue?
 *  - does **Y**?
 *  - how many questions does each half ask?
 *
 * That last column is the one that decides the shape, because of what the engine's gate can do.
 * `ChoiceDecisionSpec.askOnlyIfChosen` holds a question back on an **option word** that was chosen
 * (D450); nothing can hold one back on "an earlier card answer came back non-empty". So:
 *
 *  - **X asks nothing** (a draw, a mana or life payment): "if you do" *is* "you said yes", so Y's
 *    own questions can ride the same gate and the reading is complete.
 *  - **X asks once** (a sacrifice, a discard, a bounce): "if you do" is "that answer was not empty",
 *    which an effect can read and a question cannot be gated on — so Y must ask nothing.
 *  - **X asks more than once**, or either half points at a target: out of scope, counted separately
 *    rather than hidden in a total.
 *
 * The buckets are therefore a build order, not a ranking: the first two are what one increment can
 * read correctly, and the rest are the reasons the other cards stay badged.
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

const PROBE = 'Probe Beast';
const asCard = (text) => ({
  name: PROBE,
  type_line: 'Creature — Human',
  mana_cost: '{2}{G}',
  cmc: 3,
  colors: ['G'],
  power: '2',
  toughness: '2',
  loyalty: null,
  layout: 'normal',
  oracle_text: text,
});

const memo = new Map();
/**
 * What one clause reads as, under a trigger prologue that is known to read: `null` when the clause
 * does not read at all, otherwise how many questions and targets it carries.
 */
function readingOf(clause) {
  if (!memo.has(clause)) {
    let out = null;
    try {
      const compiled = compileCard(asCard(`When ${PROBE} enters, ${clause}.`));
      if (compiled.ok && (compiled.unread ?? []).length === 0) {
        const trigger = (compiled.script?.triggers ?? [])[0];
        out = {
          asks: (trigger?.decisions ?? []).length + (trigger?.targets ?? []).length,
        };
      }
    } catch {
      out = null;
    }
    memo.set(clause, out);
  }
  return memo.get(clause);
}

const all = file === null ? poolRows() : JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;

console.log(`Source: ${file ?? 'the engine pool'}`);
console.log(`    ${provenanceLine()}`);
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

/** `<prologue> you may <X>. If you do, <Y>`, with the prologue optional. */
const SHAPE = /^(.*?)\byou may ([^.]+)\.\s*if you do,\s*(.+?)\.?$/i;
const buckets = new Map([
  ['X asks nothing (Y may ask)', []],
  ['X asks once, Y asks nothing', []],
  ['X asks once, Y asks too', []],
  ['X asks more than once', []],
  ['X unread', []],
  ['Y unread', []],
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
  const match = SHAPE.exec(unread[0].trim());
  if (match === null) continue;
  oneShort += 1;
  const [, prologue, x, y] = match;
  const xr = readingOf(x.trim());
  const yr = readingOf(y.trim());
  const where = xr === null ? 'X unread'
    : yr === null ? 'Y unread'
      : xr.asks === 0 ? 'X asks nothing (Y may ask)'
        : xr.asks > 1 ? 'X asks more than once'
          : yr.asks === 0 ? 'X asks once, Y asks nothing'
            : 'X asks once, Y asks too';
  buckets.get(where).push(
    `${row.name}: you may ${x.trim()}. If you do, ${y.trim()}.`
    + (prologue.trim() === '' ? '' : `   [after: ${prologue.trim()}]`),
  );
}

console.log(`\nCards one unread line short whose line is this construct: ${oneShort}\n`);
for (const [key, cards] of buckets) {
  console.log(`  ${String(cards.length).padStart(4)}  ${key}`);
  if (cards.length > 0) console.log(`         e.g. ${cards[0]}`);
}
const readable = buckets.get('X asks nothing (Y may ask)').length
  + buckets.get('X asks once, Y asks nothing').length;
console.log(`\nWhat one reader can finish correctly today: ${readable} cards`);
console.log('(the other buckets are not a ranking — they are the reasons those cards stay badged)');

if (buckets.has(DUMP)) {
  const cards = buckets.get(DUMP);
  console.log(`\n${cards.length} in "${DUMP}":`);
  for (const line of cards) console.log(`  ${line}`);
}
