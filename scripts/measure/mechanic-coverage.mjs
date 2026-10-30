/**
 * How many cards hold each mechanic up?
 *
 * The suite asserts both directions of the *card* question — every card in every deck has a script
 * (`deck coverage`), and every script is registered under a name some card or token has. Neither
 * asks the **mechanic** question: for each thing the engine can do, how many cards actually do it?
 *
 * One is a single point of failure, and #220 proved it the expensive way. Two cards were needed in
 * `arc-tempest` and the obvious way to pay for them was to cut two singletons; cutting them broke
 * **26 tests**, because each was the only card in the pool exercising its mechanic. Nothing said so
 * in advance. A starter-deck one-of is load-bearing and there was no way to know which.
 *
 * Zero is worse, and quieter. A capability the engine has, the docs describe, and no card reaches
 * is a claim that cannot fail — it just stops being true, and the next person to read `effects.ts`
 * believes it.
 *
 * So this counts, and sorts ascending, so the fragile rows are the first thing on the screen.
 *
 *   node scripts/measure/mechanic-coverage.mjs          # the thin rows
 *   ALL=1 node scripts/measure/mechanic-coverage.mjs    # every mechanic, however well covered
 *
 * **Where the list of mechanics comes from is the design.** Not a literal written here: that is a
 * second thing to forget, which is `card-promises.mjs`'s own lesson and this file would have
 * repeated it. It is read out of the source instead — the field names of `CardScript`, the `kind`
 * literals of `TriggerEvent`, and the exported `KEYWORDS` — so a mechanic added to the engine
 * tomorrow shows up here at zero without anybody remembering to add it. Precedent for reading a
 * declaration out of source with a regex: the legacy Postgres suite reads `badWords` out of
 * `server.js` the same way (#111).
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     node scripts/measure/mechanic-coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  KEYWORDS, STARTER_DECKS, TOKEN_DEFS, printedKeywords, scriptFor,
} from '../../packages/rules-engine/dist/index.js';

const ALL = process.env.ALL === '1';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'rules-engine', 'src');

/*
  The declared surface, read off the TypeScript rather than remembered.

  `CardScript`'s optional fields are the mechanics a card can carry, and `TriggerEvent`'s `kind`
  literals are the events a trigger can watch. Both are unions that have grown every week of this
  project, and a count taken against a copy of them would be a count of last month's engine.

  Read **by line** rather than with one regex over the whole file, which the first draft did and got
  wrong: a union's body is every line after its header that is indented, and `/^\n/m` matches at
  offset zero because `^` is also the start of the string, so the trigger list came back empty.
  Taking lines until an un-indented one ends both declarations exactly — an interface at its `}`, a
  union at whatever is declared next — and it is the same rule for both.

  If either declaration is ever reformatted so that stops working, the lists come back empty and
  the output says so and exits non-zero rather than quietly reporting that the engine can do
  nothing. See the guard below `declared`.
*/
const sourceOf = (file) => readFileSync(join(SRC, file), 'utf8');

const bodyAfter = (text, header) => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(header));
  if (at === -1) return '';
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    body.push(line);
  }
  return body.join('\n');
};

const scriptTypes = sourceOf('scriptTypes.ts');

/** Every field a card script can carry, including the plumbing — classified below, not filtered. */
const SCRIPT_FIELDS = [...bodyAfter(scriptTypes, 'export interface CardScript {')
  .matchAll(/^ {2}readonly ([a-zA-Z]+)\??:/gm)].map((m) => m[1]);

/** Every event a trigger can watch, as `settle` raises them. */
const TRIGGER_KINDS = [...new Set([...bodyAfter(scriptTypes, 'export type TriggerEvent =')
  .matchAll(/\bkind: '([a-z-]+)'/g)].map((m) => m[1]))];

/*
  The `CardScript` fields that are not mechanics.

  Every card has a `name`; nearly every spell has `targets` and an `onResolve`. Counting those
  alongside `ninjutsu` would bury the rows this exists to surface under rows that are trivially at
  sixty. They are *listed* rather than filtered by a rule, because a rule ("anything over N") would
  also hide a mechanic that happens to be popular, and the point is to hide nothing by accident.
*/
const PLUMBING = new Set([
  'name', 'targets', 'onResolve', 'beforeDecisions', 'decisions', 'modal', 'keywords',
  'triggers', 'abilities', 'statics', 'replaces', 'costModifiers', 'additionalCost',
]);

/*
  The rows that are **meant** to be thin, with why, so a reader spends their attention on the
  others. Same shape as `card-promises.mjs`'s `KNOWN`, and for the same reason: an instrument whose
  known-good rows are undocumented gets re-investigated every time somebody runs it.

  These are claims about the pool's design, not excuses. Each one is a decision with an entry
  behind it, and if a count here stops matching what the note says, the note is what is wrong.
*/
const EXPECTED_THIN = new Map([
  /*
    Written here first as "card-less on purpose", which is what five places in the docs still say
    and what D238 said this morning — and the run below put **City of Brass** next to it. #69 gave
    this trigger a card and the claim has been stale ever since. The note is now what is true.
  */
  ['trigger becomes-tapped', 'one card since #69: every other card that would use it charges you for your own mana'],
  ['trigger transformed', 'one card by design — Awoken Horror is the pool\'s only transform trigger (D234)'],
  ['keyword myriad', 'granted by Blade of Selves rather than printed, so one is the whole mechanic (D228)'],
  ['keyword infect', 'the win condition Blight Vector is built around; concentrated on purpose (D138)'],
]);

/** name -> the cards that carry it. A Set, because a card with two faces must not count twice. */
const carriers = new Map();
const note = (mechanic, card) => {
  const found = carriers.get(mechanic) ?? new Set();
  found.add(card);
  carriers.set(mechanic, found);
};

/*
  And the cards that put a keyword on the board from **inside an effect**, which is the blind spot
  this file shipped with and the one that made its first published number wrong.

  A keyword on a card is readable three ways — printed in the text, declared in `script.keywords`,
  granted by an `equipBonus` — and all three are data. The fourth way is a `pump(..., { keywords:
  ['hexproof'] })` inside an `onResolve`, which is a **closure**: there is no property to read, so
  the first run counted hexproof at one card (Sigarda) when Blossoming Defense and Dive Down both
  grant it. "Rests on one card" was published about a keyword three cards put into play.

  The only thing available about a closure is its source, so that is what this reads. Which makes
  it a **reader's signal rather than a count**, for a reason worth stating: a function that mentions
  `'hexproof'` might be granting it or might be checking for it — a removal spell filtering for
  creatures it can legally target mentions the same string. So these are tallied and printed
  separately, never silently added to the data count, and the thin filter uses the **sum** because
  the question this file answers is "could cutting one card take this mechanic out of the pool",
  and for that an over-count is the safe direction.

  Same posture as `card-promises.mjs`: a reader's instrument with its false positives declared,
  because narrowing until the output is clean is narrowing until it finds nothing.
*/
const viaEffect = new Map();
const noteEffect = (mechanic, card) => {
  const found = viaEffect.get(mechanic) ?? new Set();
  found.add(card);
  viaEffect.set(mechanic, found);
};

/** Every function reachable in a script, as source, which is all a closure will say about itself. */
const effectSource = (value, depth = 0) => {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'function') return value.toString();
  if (Array.isArray(value)) return value.map((v) => effectSource(v, depth + 1)).join('\n');
  if (typeof value === 'object') {
    return Object.values(value).map((v) => effectSource(v, depth + 1)).join('\n');
  }
  return '';
};

/*
  Every castable face as well as every card, because a mechanic lives on the half that has it: the
  adventure on an adventurer, the spell on a modal double-faced card, each half of a split. The
  same walk `deck coverage` does, for the same reason.
*/
const facesOfCard = (card) => [card, ...(card.faces?.cards ?? [])];

const everyCard = () => {
  const seen = new Map();
  for (const deck of Object.values(STARTER_DECKS)) {
    for (const card of [...deck.cards.map((c) => c.card), deck.commander].filter(Boolean)) {
      for (const face of facesOfCard(card)) seen.set(face.name, face);
    }
  }
  // Tokens have scripts and no deck, and a token's trigger is as real as a card's: a Pest's death
  // trigger fires every game Sedgemoor Witch connects. Counted, and marked, because a mechanic held
  // up only by a token is held up by something no player can draw.
  for (const token of TOKEN_DEFS) seen.set(`${token.name} (token)`, token);
  return seen;
};

for (const [name, card] of everyCard()) {
  const script = scriptFor(card.name);
  if (script !== undefined) {
    for (const field of Object.keys(script)) {
      if (PLUMBING.has(field)) continue;
      note(`script ${field}`, name);
    }
    /*
      `TriggerDef.on`, not `.event` — which the first run got wrong, and the output said so: every
      trigger kind read zero, including `etb` and `dies`, in a pool where most creatures have one.
      An optional-chained read of a field that does not exist is silent, so the only thing that
      catches it is a number that cannot be true.
    */
    for (const trigger of script.triggers ?? []) {
      if (trigger.on?.kind !== undefined) note(`trigger ${trigger.on.kind}`, name);
    }
  }
  /*
    Keywords are read from the printed text and from the script's grant, because both are ways a
    card has a keyword and neither is the whole story: `printedKeywords` finds the flier whose whole
    text is "Flying" and has no script at all, and the script's `keywords` finds the one that is
    granted by an effect.
  */
  for (const keyword of printedKeywords(card.oracleText ?? '')) note(`keyword ${keyword}`, name);
  for (const keyword of script?.keywords ?? []) note(`keyword ${keyword}`, name);
  for (const granted of script?.equipBonus?.keywords ?? []) note(`keyword ${granted}`, name);

  // The fourth route: a keyword handed out while something resolves. See `viaEffect`.
  if (script !== undefined) {
    const source = effectSource(script);
    for (const keyword of KEYWORDS) {
      if (source.includes(`'${keyword}'`) || source.includes(`"${keyword}"`)) {
        noteEffect(`keyword ${keyword}`, name);
      }
    }
  }
}

/*
  The declared set, which is the half that finds a zero. Counting what the cards carry can only ever
  find what some card carries; a mechanic with no cards at all exists in the engine and in nothing
  else, and that is the row most worth printing.
*/
const declared = [
  ...SCRIPT_FIELDS.filter((f) => !PLUMBING.has(f)).map((f) => `script ${f}`),
  ...TRIGGER_KINDS.map((k) => `trigger ${k}`),
  ...KEYWORDS.map((k) => `keyword ${k}`),
];

if (SCRIPT_FIELDS.length === 0 || TRIGGER_KINDS.length === 0) {
  console.log('could not read the declarations out of scriptTypes.ts — the parse below is empty,');
  console.log('so every count would read zero. Fix the parse rather than believing the output.');
  process.exit(1);
}

const rows = [...new Set([...declared, ...carriers.keys()])]
  .map((mechanic) => {
    const cards = [...(carriers.get(mechanic) ?? [])].sort();
    // Only the ones the data does not already have: a card counted twice is not a second card.
    const granted = [...(viaEffect.get(mechanic) ?? [])].filter((c) => !cards.includes(c)).sort();
    return {
      mechanic,
      cards,
      granted,
      reach: cards.length + granted.length,
      declaredOnly: !carriers.has(mechanic) && !viaEffect.has(mechanic),
    };
  })
  .sort((a, b) => a.reach - b.reach || a.mechanic.localeCompare(b.mechanic));

const THIN = 2;
const shown = ALL ? rows : rows.filter((r) => r.reach < THIN);

console.log(`${declared.length} mechanics declared in the engine, ${rows.length} counted`);
console.log(`${SCRIPT_FIELDS.length} CardScript fields read, ${TRIGGER_KINDS.length} trigger kinds, `
  + `${KEYWORDS.length} keywords`);
console.log(ALL
  ? '\nevery mechanic, thinnest first'
  : `\nheld up by fewer than ${THIN} cards — ALL=1 for the rest`);
console.log('');

for (const row of shown) {
  const why = EXPECTED_THIN.get(row.mechanic);
  const count = String(row.reach).padStart(3);
  console.log(`${count}  ${row.mechanic}${why === undefined ? '' : '   (expected)'}`);
  if (row.cards.length > 0 && row.cards.length <= 5) console.log(`       ${row.cards.join(', ')}`);
  if (row.granted.length > 0 && row.granted.length <= 5) {
    console.log(`       + in an effect: ${row.granted.join(', ')}`);
  }
  if (why !== undefined) console.log(`       ${why}`);
}

/*
  And the one number that is a claim rather than a reading: how many thin rows are *unexplained*.
  A run whose last line is zero is a pool where every fragile mechanic is fragile on purpose, and
  that is the state worth being able to get back to.
*/
const unexplained = rows.filter((r) => r.reach < THIN && !EXPECTED_THIN.has(r.mechanic));
console.log('');
console.log(`${unexplained.length} thin and unexplained, ${rows.filter((r) => r.declaredOnly).length} `
  + 'declared with no card at all');
