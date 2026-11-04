/**
 * Which formats is each card legal in — from a source this container can reach.
 *
 * ## Why this exists
 *
 * The goal names the cards it wants: "every card in Magic the Gathering that is not silly, no
 * uncards, cards that are legal in normal format, so like standard, legacy, modern, pauper,
 * commander, and the actual played competitive formats." Until now the corpus could not answer
 * that. `scripts/corpus/from-forge.mjs` says so in its own docblock — Forge's card files carry no
 * legality, that lives in Scryfall's `legalities` object and MTGJSON's, and both hosts are refused
 * by the egress proxy — so **everything** was kept, un-sets and Archenemy schemes included, and
 * the coverage figure was deliberately pessimistic rather than wrong.
 *
 * It turns out Forge does ship legality, in a different part of the tree than the card files:
 *
 * - `forge-gui/res/formats/Sanctioned/*.txt` — one file per sanctioned format, each with a `Sets:`
 *   allowlist of set codes, a `Banned:` list of card names, and for Pauper a `Rarities:` list.
 * - `forge-gui/res/formats/Casual/Commander.txt` — a `Banned:` list and **no** `Sets:`, which is
 *   Commander: every paper set is legal.
 * - `forge-gui/res/editions/*.txt` — one file per set, with `Code=`, `Type=` and a `[cards]` block
 *   of `<number> <rarity> <name>` lines.
 *
 * Put together, those answer the question per card: which sets was it printed in, at what rarity,
 * and does any format's allowlist contain one of them.
 *
 * ## What is a judgement here, and what is read from the source
 *
 * Read from the source: every set code, every card's set membership and rarity, every `Sets:`
 * allowlist, every `Banned:` and `Restricted:` list.
 *
 * Three judgements, each stated because each excludes cards:
 *
 * 1. **`Type=Funny` sets are legal nowhere.** These are the un-sets, which the goal excludes by
 *    name ("no uncards, nothing silly"). Forge labels 25 sets this way.
 * 2. **`Type=Online` sets are legal in no paper format.** Arena- and MTGO-only products (Alchemy
 *    rebalances, Jumpstart digital sets). `from-forge.mjs` already skips the `rebalanced/`
 *    directory for the same reason; this catches the rest.
 * 3. **A card whose type line is not a legal card type is legal nowhere** — Scheme, Plane,
 *    Phenomenon, Vanguard, Conspiracy, Dungeon, Emblem, Attraction, Sticker, Contraption. These
 *    are not cards you put in a deck, and they are why "Whenever chaos ensues" (136 cards) and
 *    "When you set this scheme in motion" (81) were the two biggest buckets in the compiler's work
 *    queue: real work queued against cards nobody can play.
 *
 * ## Fidelity, stated rather than assumed
 *
 * Forge's format files are a community-maintained transcription of Wizards' banned lists, exactly
 * as its `Oracle:` lines are of the printed text. So this carries the same caveat `from-forge.mjs`
 * records, and for the same reason (D259 applies to the source as much as to the reader): a banned
 * list can lag an announcement, and a set can be missing from an allowlist. It is a **second-best
 * source**, recorded as such, and the moment Scryfall egress opens its `legalities` object
 * replaces this with no change to anything downstream — which is why the output is Scryfall's
 * shape and Scryfall's vocabulary (`legal`, `banned`, `restricted`, `not_legal`) rather than a
 * spelling of this script's own.
 *
 * `--check` is what keeps that honest: a table of cards whose legality is not in dispute, asserted
 * against the output. It exits non-zero on any disagreement, so a parse that silently stopped
 * reading a file cannot pass.
 *
 *   node scripts/corpus/legality.mjs <forge-gui/res> [out.json]
 *   node scripts/corpus/legality.mjs <forge-gui/res> --check
 *
 * The output is `{ "<card name>": { "<format>": "<status>" } }`. Not committed, for the same
 * reason the corpus is not: it is derived from somebody else's data file.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , resDir, outArg] = process.argv;
if (resDir === undefined) {
  console.error('usage: node scripts/corpus/legality.mjs <forge-gui/res> [out.json|--check]');
  process.exit(2);
}
const CHECK = outArg === '--check';
const out = CHECK ? null : (outArg ?? 'forge-legality.json');

/**
 * The formats this emits, in Scryfall's spelling, and where Forge keeps each one.
 *
 * Deliberately only the ones the goal names plus Pioneer, which is the other format people
 * actually play. Historic and Brawl are left out on purpose: they are Arena formats whose card
 * pool needs Forge's `Additional:` list, and nobody is uploading an Arena-only deck to a table
 * that plays paper Magic.
 */
const FORMATS = [
  ['standard', 'Sanctioned/Standard.txt'],
  ['pioneer', 'Sanctioned/Pioneer.txt'],
  ['modern', 'Sanctioned/Modern.txt'],
  ['legacy', 'Sanctioned/Legacy.txt'],
  ['vintage', 'Sanctioned/Vintage.txt'],
  ['pauper', 'Sanctioned/Pauper.txt'],
  ['commander', 'Casual/Commander.txt'],
];

/** Set types that are legal in no paper constructed format. See the docblock. */
const UNPLAYABLE_SET_TYPES = new Set(['Funny', 'Online']);

/**
 * Card types that are not cards you put in a deck (CR 108.2a and the supplemental-product types).
 *
 * Matched against the printed type line, so `Ongoing Scheme` and `Scheme` both land here.
 */
const UNPLAYABLE_TYPES = [
  'Scheme', 'Plane', 'Phenomenon', 'Vanguard', 'Conspiracy', 'Dungeon', 'Emblem',
  'Attraction', 'Sticker', 'Contraption',
];

/** `Banned:Foo; Bar; Baz` as a set of names. */
function nameList(value) {
  if (value === undefined) return new Set();
  return new Set(value.split(';').map((s) => s.trim()).filter((s) => s !== ''));
}

/** One format file as its fields. `Sets:` is comma-separated, the name lists semicolon. */
function readFormat(path) {
  const fields = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0 || line.startsWith('#') || line.startsWith('[')) continue;
    const key = line.slice(0, at).trim();
    if (!fields.has(key)) fields.set(key, line.slice(at + 1));
  }
  const sets = fields.get('Sets');
  return {
    name: fields.get('Name')?.trim() ?? '?',
    // Absent means every set, which is what Commander prints.
    sets: sets === undefined
      ? null
      : new Set(sets.split(',').map((s) => s.trim()).filter((s) => s !== '')),
    rarities: fields.get('Rarities') === undefined
      ? null
      : new Set(fields.get('Rarities').split(',').map((s) => s.trim())),
    banned: nameList(fields.get('Banned')),
    restricted: nameList(fields.get('Restricted')),
  };
}

/**
 * Every printing: card name -> the set codes and rarities it appeared at.
 *
 * A `[cards]` line is `<number> <rarity> <name> [@artist]`, and the **rarity** is what identifies
 * it: a single letter from Forge's own set. Anything else in that block is a token or sheet entry
 * — `2 r_1_1_gremlin` is one — and is skipped by requiring that letter rather than by guessing at
 * the name.
 *
 * The collector number is deliberately *not* constrained, which cost a measurement to learn. The
 * first version of this required plain digits, and Forge's numbers are not plain digits: 374 lines
 * use a foil suffix (`123F`), 345 a star (`1★`, which is how every Archenemy scheme and Planechase
 * plane is numbered), 310 a set prefix (`M-1`, `DOM-1`), and 385 a half suffix (`123a`/`123b`, the
 * two halves of a split or flip card). All of them were being dropped in silence. For a card whose
 * only printing carries one, that is not a cosmetic miss: it vanishes from this map entirely and
 * every format reads `not_legal`, which is the most damaging direction a legality bug can point.
 */
function readPrintings(editionsDir) {
  const RARITIES = new Set(['C', 'U', 'R', 'M', 'S', 'L', 'P']);
  const printings = new Map();
  let files = 0;
  let skippedSets = 0;
  for (const file of readdirSync(editionsDir)) {
    if (!file.endsWith('.txt')) continue;
    files += 1;
    const text = readFileSync(join(editionsDir, file), 'utf8');
    const code = /^Code=(.+)$/m.exec(text)?.[1]?.trim();
    const type = /^Type=(.+)$/m.exec(text)?.[1]?.trim() ?? 'Other';
    if (code === undefined) continue;
    if (UNPLAYABLE_SET_TYPES.has(type)) { skippedSets += 1; continue; }
    const cards = text.split(/^\[cards\]$/m)[1];
    if (cards === undefined) continue;
    for (const line of cards.split('\n')) {
      if (line.startsWith('[')) break;
      const m = /^\S+\s+([A-Za-z])\s+(.+?)(?:\s+@.*)?$/.exec(line.trim());
      if (m === null || !RARITIES.has(m[1].toUpperCase())) continue;
      const name = m[2].trim();
      if (name === '') continue;
      if (!printings.has(name)) printings.set(name, []);
      printings.get(name).push({ code, rarity: m[1].toUpperCase() });
    }
  }
  return { printings, files, skippedSets };
}

const formatsDir = join(resDir, 'formats');
const editionsDir = join(resDir, 'editions');
for (const dir of [formatsDir, editionsDir]) {
  if (!existsSync(dir)) {
    console.error(`!! ${dir} does not exist — is this forge-gui/res?`);
    process.exit(2);
  }
}

const formats = FORMATS.map(([key, path]) => {
  const full = join(formatsDir, path);
  if (!existsSync(full)) {
    console.error(`!! ${full} does not exist — Forge's format files have moved`);
    process.exit(2);
  }
  return [key, readFormat(full)];
});
const { printings, files, skippedSets } = readPrintings(editionsDir);

/**
 * One card's legality in one format.
 *
 * `banned` and `restricted` are reported even for a card the format's sets do not contain, because
 * that is what Scryfall does and because the distinction matters: "banned" says the format knows
 * this card and refuses it, "not_legal" says the card is outside the pool.
 */
function statusFor(name, prints, format) {
  if (format.banned.has(name)) return 'banned';
  const inPool = prints.filter((p) => format.sets === null || format.sets.has(p.code));
  if (inPool.length === 0) return 'not_legal';
  if (format.rarities !== null && !inPool.some((p) => format.rarities.has(p.rarity))) {
    return 'not_legal';
  }
  if (format.restricted.has(name)) return 'restricted';
  return 'legal';
}

/** Whether this card's printed type line is a type you can put in a deck at all. */
const typeLineOf = (() => {
  // Read from the card files when they are beside the formats, so the type check needs no corpus.
  const dir = join(resDir, 'cardsfolder');
  const lines = new Map();
  if (existsSync(dir)) {
    for (const sub of readdirSync(dir)) {
      const path = join(dir, sub);
      let inner;
      try { inner = readdirSync(path); } catch { continue; }
      for (const file of inner) {
        if (!file.endsWith('.txt')) continue;
        const text = readFileSync(join(path, file), 'utf8');
        const name = /^Name:(.+)$/m.exec(text)?.[1]?.trim();
        const types = /^Types:(.+)$/m.exec(text)?.[1]?.trim();
        if (name !== undefined && types !== undefined && !lines.has(name)) lines.set(name, types);
      }
    }
  }
  return (name) => lines.get(name);
})();

const legalities = {};
const tally = Object.fromEntries(FORMATS.map(([key]) => [key, 0]));
let unplayableType = 0;
for (const [name, prints] of printings) {
  const types = typeLineOf(name);
  const notACard = types !== undefined && UNPLAYABLE_TYPES.some((t) => types.split(/\s+/).includes(t));
  if (notACard) unplayableType += 1;
  const row = {};
  for (const [key, format] of formats) {
    const status = notACard ? 'not_legal' : statusFor(name, prints, format);
    row[key] = status;
    if (status === 'legal' || status === 'restricted') tally[key] += 1;
  }
  legalities[name] = row;
}

console.log(`Edition files read: ${files} (${skippedSets} skipped as Funny or Online)`);
console.log(`Cards with at least one printing: ${Object.keys(legalities).length}`);
console.log(`  refused as a type you cannot put in a deck: ${unplayableType}`);
console.log('Legal (or restricted) per format:');
for (const [key] of FORMATS) console.log(`  ${key.padEnd(10)} ${String(tally[key]).padStart(6)}`);
const anywhere = Object.values(legalities)
  .filter((row) => Object.values(row).some((s) => s === 'legal' || s === 'restricted')).length;
console.log(`Legal in at least one of those formats: ${anywhere}`);

/*
  The ground truth. Every row is a card whose legality is not in dispute, and the point of each is
  to be a *different* way for the parse to be wrong: a set allowlist not read, a banned list not
  read, Pauper's rarity rule not read, Vintage's restricted list not read, an un-card kept, a
  scheme kept. A parse that stopped reading half a file passes none of them.
*/
const GROUND_TRUTH = [
  // Printed in Modern-era sets and banned nowhere.
  ['Lightning Bolt', 'modern', 'legal'],
  ['Lightning Bolt', 'commander', 'legal'],
  // Alpha-only: legal in Vintage and Commander's "every paper set", outside Modern's allowlist.
  ['Black Lotus', 'modern', 'not_legal'],
  ['Black Lotus', 'vintage', 'restricted'],
  // On Modern's banned list, and legal in Legacy.
  ['Ponder', 'modern', 'banned'],
  ['Ponder', 'legacy', 'legal'],
  // On Commander's banned list.
  ['Mana Crypt', 'commander', 'banned'],
  // A basic land is every format's most legal card, and Pauper's `Rarities: L, C` must admit it.
  ['Mountain', 'pauper', 'legal'],
  ['Mountain', 'standard', 'legal'],
  // A rare is not Pauper-legal, which is the rarity rule and nothing else.
  ['Lightning Bolt', 'standard', 'not_legal'],
  ['Thoughtseize', 'pauper', 'not_legal'],
  // An Archenemy scheme and a Planechase plane are not cards you put in a deck.
  ['A Display of My Dark Power', 'commander', 'not_legal'],
  ['Academy at Tolaria West', 'commander', 'not_legal'],
  /*
    An un-card, which 1,435 cards in Forge's tree are: every set that prints them is `Type=Funny`,
    so every one of those sets is skipped and the card reaches no entry at all. `(no such card)` is
    therefore the right expectation and not a weaker one — it is the observable effect of the
    skip, and `from-forge.mjs` turns it into a row with no `legalities` field, which `isLegal`
    drops. Without this row nothing here failed when the un-set exclusion was removed, which is a
    check that cannot fail for the thing the goal names first ("no uncards").
  */
  ['Dungeon Master', 'commander', '(no such card)'],
];

if (CHECK) {
  let bad = 0;
  for (const [name, format, want] of GROUND_TRUTH) {
    const got = legalities[name]?.[format] ?? '(no such card)';
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} / ${format}: ${got}${ok ? '' : ` (wanted ${want})`}`);
  }
  console.log(`\n${GROUND_TRUTH.length - bad} of ${GROUND_TRUTH.length} ground-truth rows agree`);
  if (bad > 0) process.exit(1);
} else {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify(legalities, null, 0));
  console.log(`  -> ${out}`);
}
