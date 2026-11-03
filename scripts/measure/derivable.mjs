/**
 * What share of a real card set plays with no hand-written script at all?
 *
 * `fromCardData.ts` builds a card out of its printed data for the shapes whose rules their data
 * already is — a basic land, a vanilla creature, a creature whose whole text is keywords, a
 * readable mana source. The question that decides how much that is worth is **what fraction of an
 * actual deck it covers**, and that is a measurement, not a guess.
 *
 * Nick asked how close the Play Realm is to every Commander-legal card being playable. The honest
 * answer has two halves: 348 cards are scripted by hand, and some further share of any list needs
 * no script. This instrument reads the second half.
 *
 * ## The two arms, and why the default one is the honest one available today
 *
 * - **`pool` (default).** The engine's own 348 cards, read back as data rows. These are real cards
 *   with real printed text, assembled into thirteen decks by hand, so the output is a reading about
 *   **those decks** — not about a random sample of Magic. It is biased in a knowable direction: a
 *   deck built to exercise sixty mechanics is far heavier in cards whose text is a paragraph than a
 *   typical Commander list is, so the share derived here is a **floor**, and the real figure for a
 *   list somebody plays is higher. That bias is the reason this arm is useful rather than the
 *   reason to distrust it: a floor is a number you can act on.
 * - **`--file <path>`.** A Scryfall `oracle_cards` bulk JSON, once somebody has one. This is the
 *   arm that answers the question for all of Magic, and it needs the import from D329 to have been
 *   run on a machine that can reach Scryfall — which is Nick's call, not this script's.
 *
 * ## What it prints
 *
 * The share built, broken down by kind, and then the refusal reasons **grouped and counted**. The
 * grouping is the point: a list of 29,000 individual refusals is unreadable, and "4,112 cards were
 * refused for a line this cannot read" beside the twenty most common such lines is a work queue.
 *
 *   node scripts/measure/derivable.mjs
 *   node scripts/measure/derivable.mjs --file /path/to/oracle-cards.json
 *   VERBOSE=1 node scripts/measure/derivable.mjs      # every card and its verdict
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first.
 */
import { readFileSync } from 'node:fs';
import {
  STARTER_DECKS, cardFromData,
} from '../../packages/rules-engine/dist/index.js';

const VERBOSE = process.env.VERBOSE === '1';
const fileArg = process.argv.indexOf('--file');
const file = fileArg === -1 ? null : process.argv[fileArg + 1];

/**
 * The pool read back as data rows.
 *
 * A `CardDef` carries what a card prints, which is what a row carries, so this is a rename and not
 * a conversion. The one field it cannot supply is `produced_mana` — a definition has no such field
 * — so the cross-check that refuses a land whose text and data disagree does not run on this arm.
 * That makes the pool arm slightly *more* permissive than a real import would be, which is stated
 * here rather than left to be discovered: a land it accepts might still be refused from a row.
 */
function poolRows() {
  const seen = new Map();
  const add = (card) => {
    if (card === undefined || seen.has(card.name)) return;
    seen.set(card.name, {
      name: card.name,
      type_line: card.typeLine,
      oracle_text: card.oracleText,
      mana_cost: card.manaCost,
      cmc: card.cmc,
      colors: card.colors,
      power: card.power ?? null,
      toughness: card.toughness ?? null,
      loyalty: card.loyalty ?? null,
      layout: card.faces === undefined ? 'normal' : card.faces.kind,
    });
    // The faces of a multi-face card are cards too, and each is judged on its own.
    for (const face of card.faces?.cards ?? []) add(face);
  };
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const entry of deck.cards) add(entry.card);
    add(deck.commander);
  }
  return [...seen.values()];
}

/** A bulk JSON file's rows, accepting both the array form and one object per line. */
function fileRows(path) {
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through to the line-by-line form */
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* a partial line */ }
  }
  return rows;
}

/**
 * A refusal reason reduced to its shape, so reasons can be counted rather than listed.
 *
 * Every reason starts with the card's name, and most carry a quoted line from the card, so no two
 * are ever textually equal and a raw tally would have one entry per card. Both are stripped.
 */
function shapeOf(why) {
  return why
    .replace(/^[^:]*:\s*/, '')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\[[A-Z]*\]/g, '[…]')
    .replace(/\b\d+\/[\d*+?]+\b|\b[\d*+?]+\/[\d*+?]+\b/g, 'N/N')
    .replace(/layout \w+/, 'layout …');
}

/**
 * The opening of an unreadable line, normalised, for the second-level breakdown.
 *
 * **`shapeOf` collapses every "cannot read the line" refusal into one bucket**, which is right for
 * the top-level tally and useless for anything else — and the first version of this script stopped
 * there, reporting "189 refusals, e.g. Mutavault" and calling that a work queue. It is not a work
 * queue. It is one number and one anecdote.
 *
 * So the lines themselves are grouped by what they open with: the card's own name replaced by `~`
 * (every trigger says its own name, and leaving it in gives one bucket per card), numbers and mana
 * symbols flattened, and the first six words kept. "Whenever ~ attacks" lands in one bucket however
 * many cards print it, and *that* is a thing somebody can decide whether to teach the reader.
 */
function lineOpening(line, name) {
  const words = line
    .replaceAll(name, '~')
    .replace(/\{[^}]*\}/g, '{M}')
    .replace(/\b\d+\b/g, 'N')
    .replace(/[.,:;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 6).join(' ');
}

const rows = file === null ? poolRows() : fileRows(file);
const source = file === null
  ? `the engine's own pool (${Object.keys(STARTER_DECKS).length} decks)`
  : file;

/**
 * The card type a row is, for the by-type breakdown.
 *
 * **This is the reading that transfers.** The overall share is a fact about whatever set was
 * measured, and the pool is not the set anybody plays. The share *within a card type* is much more
 * portable, because a Commander deck's type mix is roughly known — about 37 lands, some 30
 * creatures, the rest spells and other permanents — so a reader can apply their own deck's mix to
 * these rates and get a far better estimate than the aggregate gives them.
 *
 * First match wins, in the order a card is thought about: a land that is also a creature is counted
 * as a land, because what matters about it here is that it makes mana.
 */
function typeOf(row) {
  const line = String(row.type_line ?? '').toLowerCase();
  for (const t of ['land', 'creature', 'planeswalker', 'instant', 'sorcery', 'artifact', 'enchantment']) {
    if (line.includes(t)) return t;
  }
  return 'other';
}

const byKind = new Map();
const shapes = new Map();
const examples = new Map();
const byType = new Map();
/** Unreadable lines grouped by their opening — the actual work queue. See `lineOpening`. */
const openings = new Map();
let built = 0;

for (const row of rows) {
  const result = cardFromData(row);
  const type = typeOf(row);
  const seen = byType.get(type) ?? { total: 0, built: 0 };
  seen.total += 1;
  if (result.ok) {
    built += 1;
    seen.built += 1;
    byKind.set(result.kind, (byKind.get(result.kind) ?? 0) + 1);
    if (VERBOSE) console.log(`  built  ${result.kind.padEnd(17)} ${row.name}`);
  } else {
    const shape = shapeOf(result.why);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    if (!examples.has(shape)) examples.set(shape, result.why);
    const quoted = /cannot read the line "([^"]*)"/.exec(result.why);
    if (quoted !== null) {
      const key = lineOpening(quoted[1], String(row.name ?? ''));
      const at = openings.get(key) ?? { n: 0, example: quoted[1], card: String(row.name ?? '') };
      at.n += 1;
      openings.set(key, at);
    }
    if (VERBOSE) console.log(`  no     ${result.why}`);
  }
  byType.set(type, seen);
}

const pct = (n) => rows.length === 0 ? '0.0' : ((n / rows.length) * 100).toFixed(1);

console.log(`\nSource: ${source}`);
console.log(`Cards read: ${rows.length}`);
console.log(`\nBuilt from data alone: ${built} (${pct(built)}%)`);
for (const [kind, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${pct(n).padStart(5)}%  ${kind}`);
}

console.log('\nBy card type — the reading that transfers to a deck you actually play:');
for (const [type, { total, built: ok }] of [...byType.entries()].sort((a, b) => b[1].total - a[1].total)) {
  const share = total === 0 ? '0.0' : ((ok / total) * 100).toFixed(1);
  console.log(`  ${type.padEnd(13)} ${String(ok).padStart(4)} of ${String(total).padStart(4)}  ${share.padStart(5)}%`);
}

console.log(`\nRefused: ${rows.length - built} (${pct(rows.length - built)}%)`);
const ranked = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
for (const [shape, n] of ranked.slice(0, 20)) {
  console.log(`  ${String(n).padStart(6)}  ${pct(n).padStart(5)}%  ${shape}`);
  console.log(`          e.g. ${examples.get(shape)}`);
}
if (ranked.length > 20) console.log(`  ... and ${ranked.length - 20} more shapes`);

/*
  And inside the biggest bucket, the lines themselves. This is the queue: each row is a printed
  wording, how many cards print it, and one card that does — so the next card to teach the reader
  is a decision about a number rather than about an anecdote.
*/
if (openings.size > 0) {
  const total = [...openings.values()].reduce((n, o) => n + o.n, 0);
  console.log(`\nThe ${total} unreadable lines, grouped by what they open with:`);
  const byCount = [...openings.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [key, { n, example, card }] of byCount.slice(0, 25)) {
    console.log(`  ${String(n).padStart(5)}  ${key}`);
    if (n > 1) console.log(`         e.g. ${card}: "${example}"`);
  }
  const tail = byCount.slice(25);
  if (tail.length > 0) {
    const once = tail.filter(([, o]) => o.n === 1).length;
    console.log(`  ... and ${tail.length} more openings, ${once} of them printed by a single card`);
  }
}

/*
  The caveat, printed rather than left in this file's header, because the number above will be
  quoted by somebody who did not read the header.
*/
if (file === null) {
  console.log('\nThis is the engine\'s own pool: thirteen decks built by hand to exercise sixty');
  console.log('mechanics, so it is far heavier in cards whose text is a paragraph than a list');
  console.log('somebody plays. Read the share above as a FLOOR. For the real figure, run the');
  console.log('Scryfall import (see claude/play-realm-setup.md) and pass --file.');
}
