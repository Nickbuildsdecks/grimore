/**
 * The script a card actually plays by, for every card the engine touches.
 *
 * ## Why this is its own module
 *
 * It is the one place that answers "what does this card do?" for the engine's mana, ability and
 * trigger paths, and since the oracle-text compiler landed that answer comes from **three** places
 * in precedence order: the hand-written script, the whole-card derivation, and the compiler. The
 * compiler (`compile.ts`) imports `scripts.ts`, so the answer cannot live in `scripts.ts` without a
 * cycle — which is why `scriptForCard` moved here rather than growing a third branch where it was.
 *
 * ## The precedence, and why it is safe to turn the compiler on
 *
 * 1. **The hand-written script wins, always.** All 348 cards in the pool have one, so for every
 *    card the engine plays today this is exactly `scriptFor(def.name)` and nothing is derived or
 *    compiled at all. That is what makes this change invisible to the existing suite and to every
 *    built-in deck.
 * 2. **`cardFromData`'s whole-card answer**, which `compileCard` asks for first and takes whole:
 *    lands, mana rocks and the enters-tapped clauses, read against Scryfall's own `produced_mana`
 *    where the caller has it.
 * 3. **The compiler's line-by-line reading**, which is new here. A card nobody wrote a script for
 *    and whose data gives no whole-card answer now gets whatever share of its printed text this
 *    engine can read, instead of nothing.
 *
 * ## What (3) costs, and the thing that pays for it
 *
 * A compiled script is often **partial**: a permanent's text is a list of independent abilities, so
 * the compiler reads the ones it can and leaves the rest. That is right for a permanent and it is
 * also a new way to be quietly wrong — a card that does three of its four printed things, with
 * nobody told which one is missing.
 *
 * So this module exposes `unreadLines`, and `coverage.ts` uses it to report the card as
 * `text-not-automated`. Turning the compiler on without that would trade a card the player knows
 * they must play by hand for a card that looks automated and is not, which is the trade D362 exists
 * to refuse. The two land together on purpose.
 *
 * **One check cannot run on this path, and it is worth being plain about:** a `CardDef` has no
 * `produced_mana`, so the cross-check against Scryfall's own answer — the one that refuses a land
 * whose text and data disagree — is not available here. A caller that holds the database row should
 * hand *that* to `compileCard` directly and keep what it returns.
 */
import type { CardDef } from './cards.js';
import { compileCard, type Compilation, type UnreadLine } from './compile.js';
import { scriptFor } from './scripts.js';
import type { CardScript } from './scriptTypes.js';

/**
 * Keyed on the definition object rather than on the name.
 *
 * A `WeakMap` because a definition's lifetime is the game's: a custom deck's defs are created when
 * the list is resolved and dropped when the game is, and keying on the name would hold a compiled
 * script for a card nobody is playing any more. It also means a derivation belongs to the
 * definition it was read from and nothing else, which matters when two games resolve the same name
 * from different data.
 */
const COMPILED = new WeakMap<CardDef, Compilation>();

/** The compiler's answer for one definition, computed once per definition. */
function compilationFor(def: CardDef): Compilation {
  const cached = COMPILED.get(def);
  if (cached !== undefined) return cached;
  /*
    The definition read back as data, which is all a `CardDef` can give: a def with no type line is
    cardboard and `printedDef` refuses it, which is what keeps cardboard cardboard.
  */
  const result = compileCard({
    name: def.name,
    type_line: def.typeLine,
    oracle_text: def.oracleText,
    mana_cost: def.manaCost,
    cmc: def.cmc,
    colors: def.colors,
    power: def.power ?? null,
    toughness: def.toughness ?? null,
    loyalty: def.loyalty ?? null,
    layout: def.faces === undefined ? 'normal' : def.faces.kind,
    /*
      And the faces, so a two-faced definition compiles as one (D591): the front is this
      definition's own text, the rest are its `faces`. Without them a modal or transforming card
      built from data would be refused here as "more than one face" at play time, although the
      compiler that built it read every face.
    */
    ...(def.faces === undefined ? {} : {
      card_faces: [def, ...def.faces.cards].map((face, at) => ({
        name: face.name, type_line: face.typeLine,
        /*
          An adventurer's front, without the line that **quotes** its Adventure. The pool writes
          "Venture Deeper {U} (Sorcery) — Target player mills four cards…" on the creature so a
          card in hand shows both halves (`poolOracle.test.ts` lists it as a deliberate
          difference); that line is the face's rules, which the face carries itself, and read as
          the creature's it would be an unread line on a creature that has no text at all.
        */
        oracle_text: at === 0 && def.faces?.kind === 'adventure'
          ? face.oracleText.split('\n').filter((line) => !def.faces!.cards
            .some((adventure) => line.startsWith(`${adventure.name} {`))).join('\n')
          : face.oracleText,
        mana_cost: face.manaCost,
        colors: face.colors, power: face.power ?? null, toughness: face.toughness ?? null,
        loyalty: face.loyalty ?? null,
      })),
    }),
  });
  COMPILED.set(def, result);
  return result;
}

/**
 * The script a card plays by: the hand-written one, or whatever the compiler can read.
 *
 * See this module's docblock for the precedence and for why the compiler being on is safe.
 */
export function scriptForCard(def: CardDef | undefined): CardScript | undefined {
  if (def === undefined) return undefined;
  const written = scriptFor(def.name);
  if (written !== undefined) return written;
  const compiled = compilationFor(def);
  return compiled.ok ? compiled.script : undefined;
}

/**
 * The printed lines of this card that nothing is running, each with a reason — or empty.
 *
 * **Empty for every card with a hand-written script**, and that is not an optimisation: a card
 * somebody wrote a script for is automated by that script, and asking the compiler what *it* could
 * read off the same text would report a Kitchen Finks as partly manual because this module cannot
 * read "you gain 2 life" out of one of its lines. The hand-written script is the authority, so when
 * there is one there is nothing to report.
 *
 * Empty too for a card with no printed data at all: that is `no-printed-data`, which `coverage.ts`
 * detects with certainty from the empty type line and reports as the more serious thing.
 */
export function unreadLines(def: CardDef | undefined): readonly UnreadLine[] {
  if (def === undefined) return [];
  if (scriptFor(def.name) !== undefined) return [];
  const compiled = compilationFor(def);
  return compiled.ok ? compiled.unread : [];
}
