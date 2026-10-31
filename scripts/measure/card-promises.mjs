/**
 * Does every card do what its own text promises?
 *
 * The suite already asserts every castable face in every deck **has** a script. Nothing asserts a
 * script carries everything the card's printed `oracleText` says — and that gap is the worst shape
 * of bug this project can have: a card that silently does less than it reads throws nothing, fails
 * no test, and costs a player a game they cannot tell they lost to the engine rather than to their
 * own misreading.
 *
 * So this reads the text and asks what it promised. Mechanically, and from the card's own words
 * rather than from a list kept beside them, because a list beside them is a second thing to forget.
 *
 * **It is a reader's instrument and it has false positives on purpose.** Oracle text is prose, and
 * several things are carried by the type line or by the engine rather than by a script — a Vehicle's
 * crew, a land's tap ability, a token's own definition. Narrowing until the output is empty would
 * mean narrowing until it cannot find anything either. Every false positive that has been
 * investigated is listed in `KNOWN` below with what it turned out to be, so the next reader spends
 * their time on new rows rather than on these.
 *
 *   node scripts/measure/card-promises.mjs            # the gaps
 *   VERBOSE=1 node scripts/measure/card-promises.mjs  # every card and every promise read off it
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first.
 */
import {
  KEYWORDS, STARTER_DECKS, printedKeywords, scriptFor,
} from '../../packages/rules-engine/dist/index.js';

const VERBOSE = process.env.VERBOSE === '1';

/*
  Reminder text, which restates the keyword it follows and would double every match.

  "Affinity for artifacts (This spell costs {1} less to cast for each artifact you control.)" names
  affinity once as a keyword and once as a sentence, and the sentence mentions casting and costs,
  which is enough to look like three more promises. Stripped first, so everything below reads the
  card rather than the explanation of the card.
*/
const withoutReminders = (text) => text.replace(/\([^)]*\)/g, ' ');

/*
  The named keyword costs and abilities, and the script field each one actually arrives as.

  **Derived from the pool rather than remembered**, which this file got wrong on its first run: a
  list written from memory had every one of these as a same-named field, and twenty-five cards
  reported a gap because their keyword is carried by `abilities` or by `triggers` instead. The
  mapping below was produced by asking, for each keyword, which script fields the cards that print
  it actually use — the same instrument-first move the audit itself is.

  Several fields per keyword where several are legitimate: `level up` is a `levelUp` field *and* an
  activated ability, and either is the card doing what it says.
*/
const KEYWORD_FIELDS = [
  // Carried by an activated ability: the keyword IS an activated ability.
  ['embalm', ['abilities']], ['eternalize', ['abilities']], ['unearth', ['abilities']],
  ['cycling', ['abilities']], ['monstrosity', ['abilities']], ['adapt', ['abilities']],
  ['proliferate', ['abilities', 'onResolve']], ['crew', ['abilities']],
  // Carried by a triggered ability: the keyword IS a triggered ability.
  ['undying', ['triggers']], ['persist', ['triggers']], ['extort', ['triggers']],
  ['storm', ['triggers']], ['cascade', ['triggers']], ['ward', ['triggers']],
  // Carried by a field of its own, which is most of them.
  ['flashback', ['flashback']], ['escape', ['escape']], ['madness', ['madness']],
  ['evoke', ['evoke']], ['dash', ['dash']], ['bestow', ['bestow']],
  ['megamorph', ['morph']], ['morph', ['morph']], ['foretell', ['foretell']],
  ['suspend', ['suspend']], ['buyback', ['buyback']], ['echo', ['echo']],
  ['cumulative upkeep', ['cumulativeUpkeep']], ['level up', ['levelUp', 'abilities']],
  ['replicate', ['replicate']], ['overload', ['overload']], ['spectacle', ['spectacle']],
  ['miracle', ['miracle']], ['dredge', ['dredge']], ['ninjutsu', ['ninjutsu']],
  ['modular', ['modular']], ['affinity', ['affinity']], ['convoke', ['convoke']],
  ['kicker', ['kicker']], ['delve', ['delve']], ['vanishing', ['vanishing']],
  ['fading', ['fading']], ['split second', ['splitSecond']],
  // Granted rather than owned.
  ['myriad', ['keywords', 'equipBonus']], ['equip', ['equipBonus', 'abilities']],
];

/*
  Rows already investigated, with what each one turned out to be.

  Kept here rather than in a commit message because the point of the list is to be read the next
  time this runs. A row that is a genuine engine shortcut says so; a row that is this instrument
  being naive says that instead.
*/
const KNOWN = new Map([
  // Carried by the type line and the engine, not by a script.
  ['land:tap', 'a land\'s mana ability comes from its type line, not a script'],
  ['token', 'a token definition is not a card in a deck'],
]);

const cards = new Map();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) {
    for (const card of [entry.card, ...(entry.card.faces?.cards ?? [])]) {
      cards.set(card.name, { card, deck: deck.id });
    }
  }
  if (deck.commander) cards.set(deck.commander.name, { card: deck.commander, deck: deck.id });
}

/** What this card's text says it does, as a list of promise names. */
function promises(card) {
  const text = withoutReminders(card.oracleText ?? '');
  const lower = text.toLowerCase();
  const out = [];

  for (const word of KEYWORDS) {
    // Word boundaries, so "reach" does not match "reaches" and "flash" does not match "flashback".
    if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(lower)) out.push(`keyword:${word}`);
  }
  for (const [word] of KEYWORD_FIELDS) {
    if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(lower)) out.push(word);
  }
  if (/\b(whenever|at the beginning of)\b/i.test(lower)) out.push('trigger');
  else if (/^when /i.test(text.trim()) || /\. when /i.test(lower)) out.push('trigger');
  // An activated ability is a cost, a colon, and an effect. "{T}:" is the common shape; a mana cost
  // or a sacrifice before the colon is the rest of it.
  if (/(\{[^}]+\}|sacrifice [^:.]*|discard [^:.]*|pay \d+ life)\s*(,\s*[^:.]*)?:/i.test(text)) {
    out.push('ability');
  }
  if (/protection from/i.test(lower)) out.push('protection');
  if (/can't be blocked/i.test(lower)) out.push('cantBeBlocked');
  if (/\bwalk\b|islandwalk|swampwalk|forestwalk|mountainwalk|plainswalk/i.test(lower)) out.push('landwalk');
  return [...new Set(out)];
}

/** Whether the script — or the card's own printed text — carries that promise. */
function carried(card, promise) {
  const script = scriptFor(card.name);
  /*
    **Two authorities for a keyword, not one.** A script may declare `keywords`, and
    `printedKeywords` reads a keyword-only line straight off the oracle text so that an unscripted
    card still behaves. Fog Bank has no keywords in its script and flies anyway, because its first
    line is "Defender, flying" and nothing else.

    Checked before the script, because it is the one that applies to a card with no script at all.
  */
  if (promise.startsWith('keyword:')) {
    const word = promise.slice('keyword:'.length);
    if (printedKeywords(card.oracleText).includes(word)) return true;
    if (script === undefined) return false;
    if ((script.keywords ?? []).includes(word)) return true;
    if ((script.statics ?? []).some((s) => (s.effect?.keywords ?? []).includes(word))) return true;
    if ((script.equipBonus?.keywords ?? []).includes(word)) return true;
    /*
      Or the card hands the keyword to something else, which is the card doing exactly what it says
      — an Aura granting shroud, a modal spell granting trample, a lord granting flying. Any of the
      shapes that can carry an effect counts, because which one a card used is not the question.
    */
    return ['onResolve', 'triggers', 'abilities', 'aura', 'modal', 'statics', 'equipBonus']
      .some((k) => script[k] !== undefined);
  }
  if (script === undefined) {
    // A permanent with no script is one with no text the engine has to run — a basic land, a
    // vanilla creature. Any other promise from such a card is a real gap.
    return false;
  }
  const [head, tail] = promise.split(':');
  const named = KEYWORD_FIELDS.find(([word]) => word === head);
  if (named !== undefined) return named[1].some((field) => script[field] !== undefined);
  switch (tail ?? head) {
    /*
      A promised trigger is carried by `triggers`, by a saga's chapters — or by `grantedTriggers`,
      which is the card declaring an ability for *something else* to have (D251).

      That last one is the fourth reader of `script.triggers` to be caught not knowing about granted
      abilities, after the bot's three in #236, and it is the same false positive in the same shape:
      Ophidian Eye's whole text is "enchanted creature has 'Whenever this creature deals damage to a
      player, draw a card'", so its printed `triggers` list is empty and this audit called the card
      unscripted. The ability exists, fires, and has a test; what was missing was the question.

      Worth the comment rather than the one-line fix on its own, because the shape recurs: a new way
      to carry an ability is a new blind spot in every instrument that enumerates the old ways, and
      nothing warns you — the audit simply reports a gap that is not there, or worse, stops
      reporting one that is.
    */
    case 'trigger': return (script.triggers ?? []).length > 0 || script.saga === true
      || (script.grantedTriggers ?? []).length > 0;
    case 'ability': return (script.abilities ?? []).length > 0;
    case 'protection': return (script.statics ?? []).some((s) => s.effect?.protectionFrom !== undefined)
      || script.onResolve !== undefined || (script.triggers ?? []).length > 0;
    case 'cantBeBlocked':
    case 'landwalk': return script.keywords !== undefined || script.onResolve !== undefined
      || (script.statics ?? []).length > 0 || (script.triggers ?? []).length > 0;
    default: return script[tail ?? head] !== undefined;
  }
}

/*
  Can this instrument still see a gap at all?

  A built-in negative control, run every time and printed with the result, because an audit that
  reports nothing is indistinguishable from an audit that *can* report nothing — and this file has
  already been both. Its first run flagged 172 cards because of a bug in its own field lookup; the
  fix took that to 25; the fix after that, built from the pool's real field names, took it to 0.
  Only one of those three numbers was the pool's fault.

  So two cards are planted. One promises flying with no script to carry it, and must be flagged.
  One promises nothing at all, and must not be. If the first ever stops being flagged, every clean
  run after that point means nothing and this line is what says so.
*/
const CONTROL_GAP = { name: '__control flier', typeLine: 'Creature — Test', oracleText: 'Flying, trample\nWhenever this attacks, draw a card.' };
const CONTROL_CLEAN = { name: '__control vanilla', typeLine: 'Creature — Test', oracleText: '' };
const controlSees = promises(CONTROL_GAP).filter((p) => !carried(CONTROL_GAP, p));
const controlQuiet = promises(CONTROL_CLEAN).filter((p) => !carried(CONTROL_CLEAN, p));

const rows = [];
let checked = 0;
for (const { card, deck } of [...cards.values()].sort((a, b) => a.card.name.localeCompare(b.card.name))) {
  const promised = promises(card);
  if (promised.length === 0) continue;
  checked += 1;
  const missing = promised.filter((p) => !carried(card, p));
  if (VERBOSE) {
    console.log(`${card.name} [${deck}] ${promised.join(' ')}${missing.length ? `  MISSING ${missing.join(' ')}` : ''}`);
  }
  for (const gap of missing) {
    const known = KNOWN.get(gap) ?? KNOWN.get(gap.split(':')[0]);
    rows.push({ name: card.name, deck, gap, known });
  }
}

console.log(`${cards.size} cards, ${checked} with text that promises something`);
/*
  The control, printed first and on every run: an unscripted card promising flying has to come back
  flagged. `printedKeywords` grants flying off a keyword-only line, so the planted card's flying is
  genuinely carried and the gaps it reports are its trigger and its second line — which is the
  point: those are the shapes a real missing script would show up as.
*/
console.log(`control: a planted unscripted card reports ${controlSees.length} gap(s)`
  + `${controlSees.length === 0 ? '  !! THIS INSTRUMENT CAN NO LONGER SEE A GAP' : ` (${controlSees.join(' ')})`}`
  + `, and a card promising nothing reports ${controlQuiet.length}`);
const live = rows.filter((r) => r.known === undefined);
const explained = rows.filter((r) => r.known !== undefined);
console.log(`${live.length} gaps to read, ${explained.length} already explained`);
for (const row of live) {
  console.log(`  ${row.gap.padEnd(26)} ${row.name} [${row.deck}]`);
  const text = (cards.get(row.name)?.card.oracleText ?? '').replace(/\n/g, ' / ');
  console.log(`      ${text.slice(0, 150)}`);
}
if (explained.length > 0) {
  console.log('already explained:');
  for (const row of explained) console.log(`  ${row.name}: ${row.known}`);
}
