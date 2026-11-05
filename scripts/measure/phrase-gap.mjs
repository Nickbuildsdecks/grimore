/**
 * Which **phrase**, if the compiler could read it, would finish the most cards?
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/phrase-gap.mjs --file corpus.json
 *   LEGAL=1 DUMP=discard node scripts/measure/phrase-gap.mjs --file corpus.json
 *
 * ## Why this exists: three wrong answers off `one-line-short.mjs`
 *
 * `one-line-short.mjs` ranks the **line** a card is held up by, grouped by its first seven words.
 * That is the right question for "how much of Magic is read" and a misleading one for "what to build
 * next", because a line is a trigger prologue and a sequence of clauses and the first seven words
 * name only the prologue. Its top rows have now been misread three times:
 *
 *  1. "Whenever ~ deals combat damage to a player" (199 cards) looked like a trigger family and is
 *     not one — probed under the card's own name the prologue already reads. So do the end-step,
 *     begin-combat and upkeep prologues. What those rows share is their *effect*.
 *  2. `may-halves.mjs` then measured that effect, `you may X. If you do, Y`, and reported **63 cards**
 *     where the prologue and the consequence both read — calling that the yield of a two-sentence
 *     reader. It never substituted **X**. Probed here, X reads for **0 of the 63**: every opener in
 *     that family ("discard a card", "sacrifice another creature", "exile it", "pay 2 life") is
 *     itself an unread clause, and `Whenever ~ attacks, discard a card.` does not read either. The
 *     yield of that reader **alone is zero cards**, and the 63 was my own figure.
 *  3. The first version of this file tried to find the blocking clause by reading each clause *alone*
 *     under a reconstructed prologue. 1,241 cards came back "several clauses" and 13,006 "prologue
 *     gap", both artefacts: a clause that refers to an earlier one cannot read alone, and a line
 *     that is a spell, a static or an activated ability has no comma prologue to find.
 *
 * The method that survives all three is **substitution in place**: leave the line exactly as printed,
 * replace one phrase with an effect known to read, and ask the compiler whether the line now reads.
 * Nothing is reconstructed, nothing is assumed about the rest of the line, and a card only counts
 * when the *whole* line reads — which is the thing a reader has to achieve.
 *
 * ## Reading it
 *
 * `finishes` is the number of cards one unread line from a finished script whose line reads once this
 * phrase does. It is a **ceiling**: the phrase still has to be read *correctly*, and some of these
 * must stay unread rather than be guessed at (see the `may` rows). It is also a **floor** on the
 * phrase's worth, since the same phrase blocks cards that have other gaps too.
 *
 * `appears` counts the cards whose line prints the phrase at all. The ratio is the interesting part:
 * a phrase with a high `appears` and a low `finishes` is a phrase whose cards are held up by
 * something else as well, and building it buys a flagged line rather than a card.
 *
 * ## `LEGAL=1`
 *
 * `isLegal` returns true for everything when `LEGAL` is unset, so a count taken without it is a count
 * of a different corpus — 33,847 rows including un-cards, against 31,654. That trap has cost this
 * project two wrong figures already (D464); every number quoted here is taken with the filter line
 * printed above it.
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../lib/engine.mjs';
import { poolRows } from '../lib/pool-rows.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { isLegal, legalLine } from '../lib/legal.mjs';

const DUMP = (process.env.DUMP ?? '').toLowerCase();
const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];

const PROBE = 'Probe Beast';
/** The stand-in. An effect that reads everywhere a clause can go, and points at nothing. */
const KNOWN = 'draw a card';

/*
  The candidates.

  Each is a phrase the corpus prints often and the compiler has no reader for, written as the
  substitution a reader for it would make redundant. `into` is what the phrase is replaced by —
  `KNOWN` for the ones that are a whole clause, and a back-reference for the two that are a
  *construct* rather than a clause, where what a reader would buy is the construct's own grammar
  and not a new effect.

  The cost-like actions are first because they are one family in Magic's grammar — something a
  player does to their own board or hand — and because they are the openers the `may` construct
  needs. Nothing in this engine reads any of them, as an effect or as an opener.
*/
const CANDIDATES = [
  { key: 'discard a card', re: /\bdiscards? (?:a|another|that|your|one|two|three) ?(?:card|cards|hand)\b/gi, into: KNOWN },
  { key: 'discard a <type> card', re: /\bdiscards? (?:a|an|two|three) \w+ cards?\b/gi, into: KNOWN },
  { key: 'sacrifice <permanent>', re: /\bsacrifices? (?:a|an|another|it|two|three|that|those|the)[^.,;]*/gi, into: KNOWN },
  { key: 'sacrifice ~', re: new RegExp(`\\bsacrifices? ${PROBE}\\b`, 'gi'), into: KNOWN },
  { key: 'exile <card> from a graveyard', re: /\bexiles? [^.,;]*?from (?:a|your|their|his or her|that player.s) graveyard/gi, into: KNOWN },
  { key: 'tap <permanent> you control', re: /\btaps? [^.,;]*?you control\b/gi, into: KNOWN },
  { key: 'remove a counter from <permanent>', re: /\bremoves? (?:a|an|two|three|all|that many|X) [^.,;]*?counters? from [^.,;]*/gi, into: KNOWN },
  { key: 'pay N life', re: /\bpays? \d+ life\b/gi, into: KNOWN },
  { key: 'return <permanent> to its owner.s hand', re: /\breturns? [^.,;]*?to (?:its|their) owner.s hand\b/gi, into: KNOWN },
  { key: 'put a counter on <permanent>', re: /\bputs? (?:a|an|two|three|X|that many) [^.,;]*?counters? on [^.,;]*/gi, into: KNOWN },
  /*
    The two constructs. `you may X. If you do, Y` is replaced by `Y` and `When you do, Y` by `Y`,
    which is **not** what either means — the point of the row is the ceiling, not the reading. A
    reader for the first must refuse the option when X cannot be performed (CR 608.2) and the second
    is a reflexive trigger (CR 603.12) that uses the stack, so neither can ship as "do Y".
  */
  { key: 'you may X. If you do, Y  (as "Y")', re: /\byou may ([^.]+)\.\s*If you do,\s*/gi, into: '' },
  { key: 'When you do, Y  (as "Y")', re: /\s*When you do,\s*/gi, into: ' ' },
];

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
/** Does this whole line read, as the only line on a plain creature? */
function reads(text) {
  if (!memo.has(text)) {
    let ok = false;
    try {
      ok = compileCard(asCard(text)).compiled.length > 0;
    } catch {
      ok = false;
    }
    memo.set(text, ok);
  }
  return memo.get(text);
}

const all = file === null ? poolRows() : JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;

console.log(`Source: ${file ?? 'the engine pool'}`);
console.log(`    ${provenanceLine()}`);
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

const tally = CANDIDATES.map((c) => ({ ...c, finishes: 0, appears: 0, example: '', dumped: [] }));
let oneShort = 0;
/** Cards finished by the cost-like family read together, which is what one increment would be. */
const COSTLIKE = new Set(['discard a card', 'discard a <type> card', 'sacrifice <permanent>',
  'sacrifice ~', 'exile <card> from a graveyard', 'tap <permanent> you control',
  'remove a counter from <permanent>', 'pay N life']);
let costlikeTogether = 0;
let costlikeThenMay = 0;

for (const row of rows) {
  let compiled;
  try {
    compiled = compileCard(row);
  } catch {
    continue;
  }
  if (!compiled.ok || compiled.unread.length !== 1) continue;
  oneShort += 1;
  const printed = compiled.unread[0].line;
  // The card's own name re-pointed at the probe's, so a self-referential clause still reads (D461).
  const line = row.name === undefined || row.name === ''
    ? printed
    : printed.replaceAll(row.name, PROBE);
  if (reads(line)) continue; // Unread as part of its card, readable alone: not this file's question.
  for (const c of tally) {
    c.re.lastIndex = 0;
    if (!c.re.test(line)) continue;
    c.appears += 1;
    c.re.lastIndex = 0;
    if (!reads(line.replace(c.re, c.into))) continue;
    c.finishes += 1;
    if (c.example === '') c.example = `${row.name}: "${printed.slice(0, 110)}"`;
    if (DUMP !== '' && c.key.toLowerCase().includes(DUMP)) c.dumped.push(`${row.name}: ${printed}`);
  }
  // The cost-like family as one increment, then the same family with the `may` construct on top.
  let folded = line;
  for (const c of CANDIDATES) {
    if (!COSTLIKE.has(c.key)) continue;
    c.re.lastIndex = 0;
    folded = folded.replace(c.re, c.into);
  }
  if (folded !== line && reads(folded)) costlikeTogether += 1;
  const withMay = folded.replace(/\byou may ([^.]+)\.\s*If you do,\s*/gi, '');
  if (withMay !== line && reads(withMay)) costlikeThenMay += 1;
}

console.log(`\nCards one unread line from finished, whose line does not read alone either: ${oneShort}`);
console.log('\nPhrase, substituted in place by an effect known to read:\n');
console.log(`  ${'finishes'.padStart(8)}  ${'appears'.padStart(7)}  phrase`);
for (const c of [...tally].sort((a, b) => b.finishes - a.finishes)) {
  console.log(`  ${String(c.finishes).padStart(8)}  ${String(c.appears).padStart(7)}  ${c.key}`);
  if (c.example !== '') console.log(`                      e.g. ${c.example}`);
}

console.log(`\nThe cost-like actions read together, as one increment: ${costlikeTogether} cards`);
console.log(`  and with "you may X. If you do, Y" on top of them:    ${costlikeThenMay} cards`);

for (const c of tally) {
  if (c.dumped.length === 0) continue;
  console.error(`\n${c.dumped.length} cards finished by "${c.key}":`);
  for (const one of c.dumped) console.error(`  ${one}`);
}

console.log(`
"finishes" is a CEILING: the phrase still has to be read correctly, and the two
"may" rows must NOT ship as the substitution they are measured with — the first
has to refuse its option when the opener cannot be performed (CR 608.2) and the
second is a reflexive trigger that uses the stack (CR 603.12).`);
