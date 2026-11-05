/**
 * Which activated abilities can loop at all? The population a "spent on nothing" rule has to cover.
 *
 *   pnpm --filter @grimore/rules-engine build
 *   LEGAL=1 node scripts/measure/free-abilities.mjs --file corpus.json
 *
 * ## Why this exists
 *
 * D462 found a pod that could not end: Umbral Mantle, printed `Equip {0}`, moved between two tapped
 * creatures for 19,854 moves. The fix was one clause in `equipMovesSideways`, and the obvious next
 * step looked like the **class** rather than the card — a rule that a seat does not take an action
 * returning it to a position it has already been at in this step (#335).
 *
 * That rule was designed, started, and **reverted**, because this file answered the question it
 * depended on: is there a card the existing filters miss? A guard with no failing case is a reader
 * written ahead of need, which is what `untapBoughtSomething`'s own docblock warns against, and a
 * break run on one cannot fail.
 *
 * ## What it asks, and why that is the right question
 *
 * A loop needs an ability that is **free and repeatable**. A cost the board can only pay once is a
 * cost that stops on its own: mana runs out, a sacrifice is spent, life runs down. So "free" here is
 * what the engine charges to activate — no mana (or `{0}`), no tap, no sacrifice, no discard, no
 * life, no energy, no loyalty, no counter removed.
 *
 * A **tap** cost is deliberately counted as charging, even though a permanent untaps every turn: the
 * tap limits the ability to once per untap, and the step advances in between. That is exactly why
 * `untapBoughtSomething` exists — an untap is what gives a tap back, and two Kiora's Followers are
 * the loop that one rule answers.
 *
 * ## The reading, at 0ee4a55 + D462 + D463, over 31,654 legal cards
 *
 * **176 free repeatable abilities, 176 cards**, and every one is already covered:
 *
 *  * **172 are `Crew N`** (whose compiled cost is `{crew: N}`, a field no "charges" test here reads,
 *    and rightly: crewing is paid by tapping creatures, which the board runs out of) — answered by `crewsAVehicle` and `crewBuysMoreThanItCosts` (the ninth of
 *    the family), and self-limiting besides, because crewing taps creatures and a board runs out of
 *    them.
 *  * **4 are Equipment with a free equip** — Grafted Wargear, Shuko, Lightning Greaves and Umbral
 *    Mantle — all answered by `equipMovesSideways`, both directions, since D462.
 *
 * So the loop class is **closed by the family for this corpus**, and #335 is a recorded negative
 * result rather than an open rule. That is a stronger statement than the rule would have been: it
 * names the whole population instead of guarding against an imagined member of it.
 *
 * **Re-run this when the corpus changes or a reader lands**, which is the standing value here. A new
 * free ability shape appearing in this output is the failing case #335 needs, available before a pod
 * finds it — which beats a 20,000-move trace read by eye.
 */
import { readFileSync } from 'node:fs';
import { compileCard } from '../../packages/rules-engine/dist/index.js';
import { isLegal, legalLine } from '../lib/legal.mjs';
import { provenanceLine } from '../lib/provenance.mjs';

const at = process.argv.indexOf('--file');
const file = at === -1 ? null : process.argv[at + 1];
if (file === null) {
  console.error('usage: LEGAL=1 node scripts/measure/free-abilities.mjs --file corpus.json');
  process.exit(2);
}
console.log(`Source: ${file}`);
console.log(`    ${provenanceLine()}`);

const all = JSON.parse(readFileSync(file, 'utf8'));
const rows = process.env.LEGAL === '1' ? all.filter(isLegal) : all;
if (process.env.LEGAL === '1') console.log(legalLine(all.length, rows.length));

const free = [];
for (const row of rows) {
  let compiled;
  try { compiled = compileCard(row); } catch { continue; }
  for (const ability of compiled.script?.abilities ?? []) {
    const cost = ability.cost ?? {};
    const charges = (cost.mana !== undefined && cost.mana !== '{0}')
      || cost.tap === true || cost.sacrifice !== undefined || cost.sacrificeSelf === true
      || cost.discardSelf === true || (cost.life ?? 0) > 0 || cost.energy !== undefined
      || cost.loyalty !== undefined || cost.removeCounter !== undefined;
    if (!charges) free.push({ name: row.name, desc: ability.description ?? '' });
  }
}

console.log(`\n${free.length} free repeatable activated abilities, across `
  + `${new Set(free.map((f) => f.name)).size} cards\n`);
/*
  `DUMP=1` lists the cards on stderr, which is how the figure below was checked — and the check
  found the **cross-check** wrong rather than the instrument. An inline probe without `LEGAL=1` read
  187 over all 33,847 rows; the eleven it added are un-cards (`_____ _____ Rocketship`, `The
  Belligerent and Useless Island`, `Unicycle`), which is exactly what the legality filter is for.
  A disagreement between two counts says one of them is wrong, not which.
*/
if (process.env.DUMP === '1') {
  for (const f of [...free].sort((a, b) => a.name.localeCompare(b.name))) console.error(f.name);
}
const shapes = new Map();
for (const f of free) {
  // The effect half, with numbers flattened: what decides whether a repeat can buy anything.
  const shape = f.desc.replace(/^[^:]*:\s*/, '').replace(/\b\d+\b/g, 'N').slice(0, 70);
  if (!shapes.has(shape)) shapes.set(shape, []);
  shapes.get(shape).push(f.name);
}
for (const [shape, names] of [...shapes.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(names.length).padStart(4)}  ${shape}`);
  console.log(`      e.g. ${names.slice(0, 3).join(', ')}`);
}
