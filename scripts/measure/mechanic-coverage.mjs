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
  /*
    Thin by design and the reason was already in the codebase, just not where this file looks.
    `makesMana` is not "this card produces mana" — it is a bot hint meaning *the whole effect is
    mana, so the search cannot see what the card did*. Burning-Tree Emissary carries the counter-case
    with a measurement: with the flag `cast-counts` read 46%, without it 101%, because a 2/2 for two
    is worth casting on its own. So a mana rock or a bird is priced by the evaluation and correctly
    does not carry it, and Dark Ritual being alone here is the field working.
  */
  ['script makesMana', 'a bot hint for a spell whose whole effect is mana, not for permanents that make it — see Burning-Tree Emissary'],
]);

/*
  And the rows that **want** a second card and cannot have one from here.

  Different from `EXPECTED_THIN` on purpose. Those rows are claims that one card is the whole
  mechanic; these are gaps with an external blocker, and collapsing the two would lose the
  distinction that matters — whether somebody has thought about the row, or whether it is waiting on
  something nobody in this container can supply.

  Every one of these is a printed Magic keyword with many real cards behind it, so a second card is
  **data and not engine work**: nothing here needs building, only text. D259 set the rule when Food
  was left out for the same reason — "inventing the text of a real card is worse than leaving the
  mechanic out" — and `api.scryfall.com` is denied by this environment's egress proxy, so the text
  cannot be verified. The reason is written once here rather than thirteen times, because thirteen
  copies of one sentence is how a list stops being read.

  **The count of this map is the number worth acting on.** It is the size of the prize for allowing
  one host through the proxy, and the moment that happens none of it is engine work.
*/
const NEEDS_CARD_DATA = 'wants a second card; a printed keyword with many real cards, blocked on verified text (D259)';
const BLOCKED_THIN = new Map([
  ['script affinity', NEEDS_CARD_DATA],
  ['script bestow', NEEDS_CARD_DATA],
  ['script copiesACreature', NEEDS_CARD_DATA],
  ['script cumulativeUpkeep', NEEDS_CARD_DATA],
  ['script dash', NEEDS_CARD_DATA],
  ['script evoke', NEEDS_CARD_DATA],
  ['script fading', NEEDS_CARD_DATA],
  ['script goadsOpponents', NEEDS_CARD_DATA],
  ['script madness', NEEDS_CARD_DATA],
  ['script ninjutsu', NEEDS_CARD_DATA],
  ['script overload', NEEDS_CARD_DATA],
  ['script spectacle', NEEDS_CARD_DATA],
  ['script vanishing', NEEDS_CARD_DATA],
]);

/** name -> the cards that carry it. A Set, because a card with two faces must not count twice. */
const carriers = new Map();
const note = (mechanic, card) => {
  const found = carriers.get(mechanic) ?? new Set();
  found.add(card);
  carriers.set(mechanic, found);
};

/*
  And the cards that **hand a keyword out** rather than having it, which is where this file's first
  two published numbers both went wrong.

  There are two readings of "how many cards hold hexproof up" and only one of them is the question.
  A card *has* the keyword if it is printed in its text or declared in `script.keywords` — that is
  data, and it is what the first version counted. A card *puts the keyword on the board* in three
  more ways, and only the first of those is data too:

   - `equipBonus.keywords` — Darksteel Plate is not indestructible, it makes a creature so
   - a `statics` entry's `effect.keywords` — Knight Exemplar's other Knights
   - `pump(..., { keywords: ['hexproof'] })` inside an `onResolve` — a **closure** with no property

  The first version read the printed text, `script.keywords` and `equipBonus`, and called that the
  count. It published **hexproof rests on one card**; hexproof is on four, because Blossoming
  Defense, Dive Down and Bristling Hydra all grant it from inside a closure. Then the fix for that
  read closure *source* and still missed Knight Exemplar, whose grant is a plain object and so says
  nothing when stringified.

  So the walk is now the whole script tree: a string **equal to** a keyword anywhere in it, plus a
  quoted keyword in any function's source, which is the only thing a closure will say about itself.
  And the line between the two columns is the honest one — **a card's own keywords, and the ones it
  gives away** — rather than the accident of which grants happen to be readable.

  It is a **reader's signal and not a count**, for a reason worth stating: a function mentioning
  `'hexproof'` might grant it or might check for it, the way a removal spell filtering for legal
  targets does. So grants print in their own column, never silently added, and the thin filter uses
  the sum, because the question here is "could cutting one card take this mechanic out of the pool"
  and for that an over-count is the safe direction. Same posture as `card-promises.mjs`: declared
  false positives beat narrowing until the output is clean.
*/
const viaEffect = new Map();
const noteEffect = (mechanic, card) => {
  const found = viaEffect.get(mechanic) ?? new Set();
  found.add(card);
  viaEffect.set(mechanic, found);
};

const KEYWORD_SET = new Set(KEYWORDS);

/**
 * Every keyword a script mentions anywhere, by either route.
 *
 * `strings` are keyword-valued strings found in the tree — exact equality, so a `description`
 * reading "destroy target non-indestructible creature" is not a match. `source` is the text of
 * every function reachable in it.
 */
const keywordsMentionedIn = (script) => {
  const found = new Set();
  const seen = new Set();
  const walk = (value, depth) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (KEYWORD_SET.has(value)) found.add(value);
      return;
    }
    if (typeof value === 'function') {
      const src = value.toString();
      for (const keyword of KEYWORDS) {
        if (src.includes(`'${keyword}'`) || src.includes(`"${keyword}"`)) found.add(keyword);
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  };
  walk(script, 0);
  return found;
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
    /*
      And the trigger kinds the card **hands out** rather than has (D251), which go in the grants
      column for the same reason a granted keyword does: an Ophidian Eye does not have a
      combat-damage trigger, it gives one to whatever it enchants.

      Found by asking which files read `script.triggers` without knowing `grantedTriggers` exists —
      this was one of five, after the bot's three in #236 and `card-promises`. **Inert today and
      measured so**: the only granted kind in the pool is `combat-damage`, which five printed cards
      already carry, so no row moves. What it buys is the day a kind is granted and printed nowhere,
      which this instrument exists to notice and would have read as absent.
    */
    for (const trigger of script.grantedTriggers ?? []) {
      if (trigger.on?.kind !== undefined) noteEffect(`trigger ${trigger.on.kind}`, name);
    }
  }
  /*
    Keywords are read from the printed text and from the script's grant, because both are ways a
    card has a keyword and neither is the whole story: `printedKeywords` finds the flier whose whole
    text is "Flying" and has no script at all, and the script's `keywords` finds the one that is
    granted by an effect.
  */
  /*
    The keywords the card **has**: printed in its text, or declared on its script. `equipBonus` is
    deliberately not here — a Darksteel Plate is not indestructible, it makes something else so,
    and counting it as a card that has the keyword is what hid the gap.
  */
  const own = new Set([
    ...printedKeywords(card.oracleText ?? ''),
    ...(script?.keywords ?? []),
  ]);
  for (const keyword of own) note(`keyword ${keyword}`, name);

  // And the ones it gives away, by any of the three routes. See `viaEffect`.
  if (script !== undefined) {
    for (const keyword of keywordsMentionedIn(script)) {
      if (!own.has(keyword)) noteEffect(`keyword ${keyword}`, name);
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
  const design = EXPECTED_THIN.get(row.mechanic);
  const blocked = BLOCKED_THIN.get(row.mechanic);
  const why = design ?? blocked;
  const count = String(row.reach).padStart(3);
  const tag = design !== undefined ? '   (expected)' : blocked !== undefined ? '   (blocked)' : '';
  console.log(`${count}  ${row.mechanic}${tag}`);
  if (row.cards.length > 0 && row.cards.length <= 5) console.log(`       ${row.cards.join(', ')}`);
  if (row.granted.length > 0 && row.granted.length <= 5) {
    console.log(`       + gives it away: ${row.granted.join(', ')}`);
  }
  if (why !== undefined) console.log(`       ${why}`);
}

/*
  And the one number that is a claim rather than a reading: how many thin rows are *unexplained*.
  A run whose last line is zero is a pool where every fragile mechanic is fragile on purpose, and
  that is the state worth being able to get back to.
*/
const thin = rows.filter((r) => r.reach < THIN);
const byDesign = thin.filter((r) => EXPECTED_THIN.has(r.mechanic));
const waiting = thin.filter((r) => BLOCKED_THIN.has(r.mechanic));
const unexplained = thin.filter((r) => !EXPECTED_THIN.has(r.mechanic) && !BLOCKED_THIN.has(r.mechanic));
console.log('');
console.log(`${byDesign.length} thin by design, ${waiting.length} waiting on card data, `
  + `${unexplained.length} thin and unexplained, `
  + `${rows.filter((r) => r.declaredOnly).length} declared with no card at all`);
if (unexplained.length > 0) {
  console.log(`unexplained: ${unexplained.map((r) => r.mechanic).join(', ')}`);
}
