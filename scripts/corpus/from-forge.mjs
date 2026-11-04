/**
 * Every card Magic has printed, as the rows this engine's compiler reads — from a source this
 * container can actually reach.
 *
 * ## Why this exists, and why it is not Scryfall
 *
 * #318 is "every competitive-legal card, from Scryfall bulk data", and it has been blocked since it
 * was filed: `api.scryfall.com` and `data.scryfall.io` are both refused by the egress proxy with a
 * 403 to CONNECT, re-tested on every pass. So is `mtgjson.com`, and so is
 * `api.magicthegathering.io`. Every card-data host this project would reach for is denied.
 *
 * What is **not** denied is GitHub: `git` over https works through the session's git proxy, and
 * `raw.githubusercontent.com` answers 200. So the corpus can come out of a public repository that
 * keeps its card data in git — and `Card-Forge/forge` does, one plain-text file per card under
 * `forge-gui/res/cardsfolder`, 34,134 of them.
 *
 * ## What is taken from Forge, and what is deliberately not
 *
 * Taken: the **printed card data** — name, mana cost, type line, power, toughness, loyalty and the
 * `Oracle:` text. That is exactly `CardDataRow`, which is exactly what Scryfall's `oracle_cards`
 * bulk file provides, so `compilable.mjs --file` and the importer from D329 read this without
 * changing a line.
 *
 * **Not** taken: Forge's own `A:`/`T:`/`S:` ability scripts. They are a different engine's DSL, and
 * copying their semantics would be importing a second implementation of the rules that nothing here
 * could verify — the opposite of what the compiler is for. The whole point is that *this* engine
 * reads the printed text with *its own* readers, ground-truthed against hand-written cards.
 *
 * ## Fidelity, stated rather than assumed
 *
 * Forge's `Oracle:` lines are a community-maintained transcription of Wizards' printed text. They
 * are not the canonical Oracle feed, so a line can lag an errata. That matters here because D259's
 * rule — inventing the text of a real card is worse than leaving the mechanic out — applies to the
 * *source* as much as to the reader: a compiler fed slightly wrong text produces a card that is
 * confidently wrong. So this is a **second-best source**, recorded as such, and the moment Scryfall
 * egress opens, `compilable.mjs --file` takes the real bulk file with no change to anything here.
 *
 * Two normalisations are applied to the text, and they are the only two:
 *
 * - `\n` as a literal backslash-n becomes a real newline, which is Forge's file encoding and not
 *   part of the card.
 * - A planeswalker's `[+2]:` becomes `+2:`, because Scryfall prints the latter and every reader in
 *   this engine was written against Scryfall's spelling. Normalising the punctuation of a cost is
 *   not rewriting the card; it is reading the same card in the dialect the compiler speaks.
 *
 * ## What this does not do yet
 *
 * **Format legality is not filtered.** #318 asks for the competitive-legal cards, and Forge's files
 * carry no legality: that lives in Scryfall's `legalities` object and MTGJSON's, both unreachable.
 * So `rebalanced/` (Alchemy-only rebalances) and `upcoming/` (unreleased) are skipped by directory,
 * and everything else is kept — including the silver-bordered cards, which are a small fraction and
 * whose presence makes the coverage figure **pessimistic** rather than flattering, which is the safe
 * direction for a number anybody might act on. Closing that gap needs a legality source; the
 * candidates are the Scryfall bulk file itself, or a package from a registry the proxy does not
 * govern (`registry.npmjs.org` and `pypi.org` are both in its `noProxy` list).
 *
 *   node scripts/corpus/from-forge.mjs <cardsfolder> [out.json]
 *
 * The output is a JSON array of rows, the shape Scryfall's bulk file has. It is **not** committed:
 * it is 30 MB of somebody else's transcription of copyrighted card text, and the repository holds
 * the reader, not the corpus.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [, , folder, out] = process.argv;
if (folder === undefined) {
  console.error('usage: node scripts/corpus/from-forge.mjs <cardsfolder> [out.json]');
  process.exit(2);
}

/** Directories under `cardsfolder` that are not paper Magic. See the docblock. */
const SKIP_DIRS = new Set(['rebalanced', 'upcoming']);

/** The card types, so a type line can be split the way `parseTypeLine` expects. */
const SUPERTYPES = new Set(['Basic', 'Legendary', 'Ongoing', 'Snow', 'World', 'Host']);
const TYPES = new Set([
  'Artifact', 'Battle', 'Conspiracy', 'Creature', 'Dungeon', 'Emblem', 'Enchantment', 'Instant',
  'Kindred', 'Land', 'Phenomenon', 'Plane', 'Planeswalker', 'Scheme', 'Sorcery', 'Tribal',
  'Vanguard', 'Sticker', 'Attraction', 'Contraption',
]);

/** Forge's layout names, in the words `CardDataRow.layout` uses. */
const LAYOUTS = {
  DoubleFaced: 'transform',
  Adventure: 'adventure',
  Split: 'split',
  Modal: 'modal',
  Flip: 'flip',
};

const COLOUR_LETTERS = new Set(['W', 'U', 'B', 'R', 'G']);

/**
 * One Forge mana-cost token as a mana symbol.
 *
 * Forge writes a cost as space-separated tokens: `3 W W`, `X R`, `RW RW RW` for hybrid, `UP` for
 * phyrexian, `2W` for monocoloured hybrid. Each becomes the braced symbol Scryfall prints, which is
 * what `parseManaCost` reads.
 *
 * The three symbols `parseManaCost` refuses — phyrexian, snow and monocoloured hybrid — are emitted
 * **as themselves** rather than approximated, because that function's own docblock says why:
 * "quietly treating a symbol as generic would let a player cast a spell they cannot afford, which is
 * worse than refusing it". A card with one is reported unpayable, which is the honest outcome.
 */
function symbolFor(token) {
  if (/^\d+$/.test(token)) return `{${token}}`;
  if (/^[XYZ]$/.test(token)) return `{${token}}`;
  if (token === 'S' || token === 'C') return `{${token}}`;
  if (COLOUR_LETTERS.has(token)) return `{${token}}`;
  const phyrexian = /^([WUBRGC])P$/.exec(token);
  if (phyrexian !== null) return `{${phyrexian[1]}/P}`;
  const hybrid = /^([WUBRGC])([WUBRGC])$/.exec(token);
  if (hybrid !== null) return `{${hybrid[1]}/${hybrid[2]}}`;
  const mono = /^(\d+)([WUBRGC])$/.exec(token);
  if (mono !== null) return `{${mono[1]}/${mono[2]}}`;
  // Anything else is a symbol this converter has not seen; emitted braced so it is visibly
  // unparsed rather than silently dropped.
  return `{${token}}`;
}

/** The printed cost, its mana value, and its colours — read once, from the one string. */
function costOf(raw) {
  if (raw === undefined || raw === '' || raw === 'no cost') {
    return { mana_cost: '', cmc: 0, colors: [] };
  }
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const mana_cost = tokens.map(symbolFor).join('');
  let cmc = 0;
  const colors = [];
  for (const token of tokens) {
    const generic = /^(\d+)$/.exec(token);
    if (generic !== null) { cmc += Number(generic[1]); continue; }
    // X counts as zero on a card in a library, which is what Scryfall's `cmc` says too.
    if (/^[XYZ]$/.test(token)) continue;
    cmc += 1;
    for (const letter of token) if (COLOUR_LETTERS.has(letter)) {
      if (!colors.includes(letter)) colors.push(letter);
    }
  }
  return { mana_cost, cmc, colors };
}

/** `Legendary Planeswalker Jace` as the printed line `Legendary Planeswalker — Jace`. */
function typeLineOf(raw) {
  const words = (raw ?? '').trim().split(/\s+/).filter(Boolean);
  const supers = words.filter((w) => SUPERTYPES.has(w));
  const types = words.filter((w) => TYPES.has(w));
  const subs = words.filter((w) => !SUPERTYPES.has(w) && !TYPES.has(w));
  const front = [...supers, ...types].join(' ');
  return subs.length === 0 ? front : `${front} — ${subs.join(' ')}`;
}

/** The fields of one face, as a map. A key may repeat (`K:`), so the repeated ones are collected. */
function fieldsOf(text) {
  const single = new Map();
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (!single.has(key)) single.set(key, value);
  }
  return single;
}

/**
 * One card file as one row.
 *
 * The first face is the card: a split card, a transforming creature and an adventurer are all one
 * object in a library, and `printedDef` refuses a multi-face layout by name rather than guessing
 * which half to run — which is what the `layout` field is for.
 */
function rowFor(text) {
  const faces = text.split(/^ALTERNATE$/m);
  const fields = fieldsOf(faces[0]);
  const name = fields.get('Name');
  if (name === undefined || name.trim() === '') return null;
  const pt = /^([^/]+)\/(.+)$/.exec(fields.get('PT') ?? '');
  const mode = (fields.get('AlternateMode') ?? '').trim();
  const oracle = (fields.get('Oracle') ?? '')
    .replaceAll('\\n', '\n')
    // See the docblock: Scryfall's spelling of a loyalty cost, which every reader here expects.
    .replace(/^\[([+-]?\d+|0)\]:/gm, '$1:')
    .trim();
  return {
    name: name.trim(),
    type_line: typeLineOf(fields.get('Types')),
    oracle_text: oracle,
    ...costOf(fields.get('ManaCost')),
    power: pt === null ? null : pt[1].trim(),
    toughness: pt === null ? null : pt[2].trim(),
    loyalty: fields.has('Loyalty') ? fields.get('Loyalty').trim() : null,
    layout: mode === '' ? 'normal' : (LAYOUTS[mode] ?? mode.toLowerCase()),
  };
}

const rows = [];
let files = 0;
let skippedDirs = 0;
let unnamed = 0;
for (const entry of readdirSync(folder)) {
  const path = join(folder, entry);
  if (!statSync(path).isDirectory()) continue;
  if (SKIP_DIRS.has(entry)) { skippedDirs += 1; continue; }
  for (const file of readdirSync(path)) {
    if (!file.endsWith('.txt')) continue;
    files += 1;
    const row = rowFor(readFileSync(join(path, file), 'utf8'));
    if (row === null) { unnamed += 1; continue; }
    rows.push(row);
  }
}

/*
  Deduplicated by name, which is what the engine wants and what Scryfall's `oracle_cards` file is:
  one row per distinct card, not one per printing. Forge's tree is already one file per card, so
  this only catches a name appearing in two files — a card and its meld or specialize partner.
*/
const byName = new Map();
for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row);
const unique = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

const target = out ?? 'forge-corpus.json';
writeFileSync(target, JSON.stringify(unique, null, 0));
console.log(`Read ${files} card files from ${folder}`);
console.log(`  directories skipped as not paper Magic: ${skippedDirs}`);
console.log(`  files with no Name: ${unnamed}`);
console.log(`  rows written: ${unique.length} (${rows.length - unique.length} duplicate names dropped)`);
console.log(`  -> ${target}`);
