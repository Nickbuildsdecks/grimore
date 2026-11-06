/**
 * The oracle-text compiler: how much of a card's printed text can this engine turn into rules, and
 * **which lines could not** (#317).
 *
 * ## The question this answers, and why `cardFromData` could not
 *
 * `fromCardData.ts` asks whether a card's text is *nothing but* its data — a vanilla creature, a
 * readable mana source, a creature whose whole text is keywords. That is an all-or-nothing
 * question, and it has to be: it returns a `CardDef` plus a complete `CardScript` or it returns a
 * refusal. Measured on the engine's own pool, it says yes to 15% of cards.
 *
 * The other 85% are not a wall. A Murderous Redcap is persist plus one sentence; a Basilica
 * Screecher is flying plus extort; a Mystic Remora is cumulative upkeep plus one triggered ability.
 * For every one of those, *some* of the text is already machinery this engine has. The question
 * worth asking at the scale of every card ever printed is therefore not "all or nothing" but "how
 * much, and what is left" — and the answer is only useful if the leftovers are **named**, because
 * a ranked list of the sentences nothing can read is the work queue for everything after this.
 *
 * Hybrid automation (D362) is what makes a partial answer worth having. A card the engine only
 * partly reads is dealt into an automated game and flagged; before that change it would have
 * dropped the whole table out of automation, and "60% of this card" would have been worth nothing.
 *
 * ## Where it sits, and why it is its own module
 *
 * `scripts.ts` imports `fromCardData.ts`. The compiler needs both — the printed data from one and
 * the parameterised builders from the other — so it cannot live in either without making that
 * dependency a cycle. It sits above both, and `customDeck.ts` is above it again.
 *
 * ## What it does not claim
 *
 * A line this reports as **compiled** is one it turned into rules the engine runs. A line it
 * reports as **uncompiled** is one nothing here could read; the card is still dealt, still has its
 * printed data, and still plays — see `coverage.ts` — but that line does not happen. The honest
 * reading of a card with any uncompiled line is "this card is partly automated", and nothing in
 * this module says otherwise.
 *
 * The compiler never invents text. Every rule it emits comes from a builder in `scripts.ts` that a
 * hand-written card in the pool already uses, with arguments read off the printed line. Inventing
 * the text of a real card is worse than leaving the mechanic out (D259).
 */
import type { CardDef } from './cards.js';
import { hasType, isPrintedAbilityLine, parseTypeLine } from './characteristics.js';
import {
  cardFromData, printedBody, printedDef, printedLoyalty, printedRulesLines,
  type CardDataRow, type DerivedKind,
} from './fromCardData.js';
import {
  isKeywordDeclaration, lineScriptFor, spellScriptFor, wholeCardShapeFor,
} from './scripts.js';
import type { CardScript } from './scriptTypes.js';

/** A printed line, and why nothing could turn it into rules. */
export interface UnreadLine {
  readonly line: string;
  /**
   * `no-reader` — nothing in the compiler recognises this line's shape at all. The common case, and
   * the one whose grouped counts are the work queue.
   *
   * `field-conflict` — a reader recognised it, but applying it would overwrite a field another line
   * had already set to something else. Reported rather than resolved: two printed lines disagreeing
   * about one script field means this module has misread one of them, and picking a winner would
   * hide that behind a card that half works.
   *
   * `unimplemented-keyword` — the line is a keyword ability declaration (`Miracle {R}`, `Equip
   * {1}`) that `keywordScriptFor` has no builder for. Counted apart from `no-reader` because it is
   * a different kind of incomplete: a keyword is a **cost or a modifier**, so the card still plays
   * and what is missing is one way to cast or use it. An unread *sentence* means the card cannot be
   * played automatically at all. Conflating the two would make any badge built on this lie in one
   * direction or the other — see `isKeywordDeclaration`.
   */
  readonly why: 'no-reader' | 'field-conflict' | 'unimplemented-keyword';
}

export interface Compiled {
  readonly ok: true;
  /** The printed data, always — the compiler's output is additive to it. */
  readonly def: CardDef;
  /** The rules it built, or undefined when it built none. */
  readonly script?: CardScript;
  /** The printed lines it turned into rules, as printed. */
  readonly compiled: readonly string[];
  /** The printed lines it could not, as printed, each with a reason. */
  readonly unread: readonly UnreadLine[];
  /**
   * How the script was arrived at.
   *
   * `whole-card` — `cardFromData` read the entire card; this is its verdict, unchanged, and `kind`
   * says which shape it recognised. `lines` — the compiler read some of the card's lines itself,
   * whether keywords or triggered abilities. `printed-only` — it read none, and the card is printed
   * data and nothing else.
   */
  readonly source: 'whole-card' | 'lines' | 'printed-only';
  readonly kind?: DerivedKind;
}

export type Compilation = Compiled | { readonly ok: false; readonly why: string };

/** Whether every printed line became rules — which is not the same as "this card works". */
export function fullyCompiled(result: Compilation): boolean {
  return result.ok && result.unread.length === 0;
}

/**
 * The script fields that are **lists of printed abilities**, where two lines each contributing one
 * is the card rather than a disagreement.
 *
 * A permanent's triggered and activated abilities are each printed one per line, and a card with
 * two of either is ordinary — a pain land prints `{T}: Add {C}.` and `{T}, Pay 1 life: Add {B}.`,
 * and both are real. So these accumulate. Every other field is a single fact about the card (its
 * size, its keywords, what it enchants), and two lines setting one of those to different values
 * means a line was misread.
 *
 * `abilities` was missing from this set until a two-ability land was compiled for the first time:
 * the second line read correctly and was then reported as a `field-conflict` against the first.
 * `statics` is here for the same reason before a card needs it — a permanent with two printed
 * continuous abilities is ordinary, and nothing about the list says they must arrive together.
 */
const ACCUMULATING = new Set(['triggers', 'abilities', 'statics']);

/**
 * Merges one line's fragment into the script being built.
 *
 * Abilities accumulate; every other field is set once. A second line setting an already-set field
 * to a different value is refused and reported, for the reason `UnreadLine.why` gives.
 */
function merge(
  into: Record<string, unknown>,
  fragment: Partial<CardScript>,
): 'merged' | 'conflict' {
  const entries = Object.entries(fragment);
  // Checked before anything is written, so a refused fragment leaves no half of itself behind.
  for (const [key, value] of entries) {
    if (ACCUMULATING.has(key)) continue;
    if (key in into && JSON.stringify(into[key]) !== JSON.stringify(value)) return 'conflict';
  }
  for (const [key, value] of entries) {
    if (ACCUMULATING.has(key)) {
      const existing = (into[key] ?? []) as readonly unknown[];
      into[key] = [...existing, ...(value as readonly unknown[])];
      continue;
    }
    into[key] = value;
  }
  return 'merged';
}

/**
 * Why a line went unread, for the two paths that cannot already tell.
 *
 * Both of them have already asked the readers and been refused; the only question left is which
 * kind of incomplete this is, and `isKeywordDeclaration` is the one thing that can say. Asking it
 * here rather than inside each path is what keeps the spell path and the permanent path reporting
 * the same line the same way.
 */
function reasonFor(line: string): 'no-reader' | 'unimplemented-keyword' {
  return isKeywordDeclaration(line) ? 'unimplemented-keyword' : 'no-reader';
}

/** A printed size this engine can use as a number. Mirrors `fromCardData`'s own test. */
const INTEGER = /^\d+$/;

/**
 * Why this creature cannot be given a size, or `null` if it can.
 *
 * The printed number is enough on its own for 18,370 of the corpus's 18,603 creatures. The other
 * 233 print `*` or `1+*`, and for those the size is a characteristic-defining ability: playable
 * exactly when the compiler read one, which is why this is asked after the lines rather than
 * before them.
 *
 * `definesSize` always supplies the power and supplies the toughness unless it says
 * `applies: 'power'` — Enigma Drake is a `*`/`4`, whose printed toughness is a real number and
 * whose power is the count. So the two halves are checked separately: a card whose power is read
 * off the board and whose toughness is a `*` nothing read would still be a creature with zero
 * toughness, and zero toughness is the same CR 704.5f death as a 0/0.
 */
function unsizeable(
  name: string,
  row: CardDataRow,
  statics: unknown,
): string | null {
  const defines = (Array.isArray(statics) ? statics : [])
    .map((entry) => (entry as { effect?: { definesSize?: { applies?: string } } })?.effect)
    .find((effect) => effect?.definesSize !== undefined)?.definesSize;
  const body = printedBody(name, row);
  if (!('why' in body)) return null;
  if (defines === undefined) return body.why;
  // The count covers the power always and the toughness unless the ability is power-only.
  if (defines.applies !== 'power') return null;
  const toughness = (row.toughness ?? '').trim();
  return INTEGER.test(toughness)
    ? null
    : `${name}: its power is a count but its toughness of ${toughness || '(none)'} is not a number`;
}

/**
 * Compilations already built, by the data they were built from.
 *
 * ## Why a cache, measured rather than assumed
 *
 * Compiling a card is read-only work over its printed text, and 99 of them cost **14.65 ms** —
 * which was fine while the only caller was a measuring script and became a problem the moment a
 * pasted deck was resolved through this function. `apps/realtime` rebuilds a seat's deck from its
 * list on **every action**, and builds every seat's summary on **every snapshot**, so a four-seat
 * pod paid that cost five times a move: with the 25-move write bound (D325) that is over a second
 * of compiling for one client message, all of it producing the identical answer.
 *
 * So: memoised, and the same 99 cards cost 0.37 ms on the second build. The cache is what makes
 * reading a pasted deck out of the card table affordable at all.
 *
 * ## The key is the whole row, deliberately
 *
 * Not the name. Two rows can carry the same name and different text — a hand-written pool card and
 * its corpus row, a corpus loaded twice from different sources, a test fixture built to probe one
 * clause — and a cache keyed on the name would hand the second caller the first one's card. That
 * is not a stale cache, it is a card with the wrong rules, and it would be invisible: the
 * compilation it returns is internally consistent and reads perfectly well.
 *
 * `JSON.stringify` of the row captures every field this function reads and several it does not,
 * which is the right way round: a key that is too specific costs a miss, and a miss costs 0.15 ms.
 * Field order affects the string, so two rows with the same fields in a different order miss rather
 * than collide — again the safe direction.
 *
 * ## Safe to cache because a `Compilation` is immutable
 *
 * The returned object is frozen in practice — nothing in this engine writes to a `Compilation`, and
 * its `def` and `script` are read by `scriptForCard` and `derive.ts` and never mutated. The scripts
 * are closures over the row, which is data. So two callers sharing one compilation share the same
 * card, which is what they would have got anyway.
 *
 * ## The cap, and the arithmetic behind the number
 *
 * Measured by compiling the whole corpus into a cache with no cap: **33,847 compilations cost
 * 172 MB**, or about 4.6 KB each, and the first pass took 86 s against 105 ms for the second. So an
 * uncapped cache is not an option on a server started with `--max-old-space-size=768`, and the cap
 * is set where the thing that needs caching fits: the cards of the lists pasted at the pods
 * currently live. A four-seat pod is at most 400 names, so **10,000** is twenty-five concurrent
 * tables of entirely distinct decks, at roughly 46 MB.
 *
 * A plain clear rather than an LRU, because what a clear costs is one rebuild per card still in
 * play and the measuring scripts that sweep all 33,847 compile each card once anyway — an eviction
 * order would buy nothing either of them would notice.
 */
const COMPILED = new Map<string, Compilation>();
const COMPILED_CAP = 10_000;

/**
 * Compiles one row of printed card data into as much of a `CardScript` as this engine can build.
 *
 * Refuses only what is not a single-face card at all — see `printedDef`. Everything else returns
 * `ok: true` with a `def`, whatever share of its text became rules, and the rest named.
 *
 * Memoised on the row — see `COMPILED` above for why that is both necessary and safe.
 */
export function compileCard(row: CardDataRow): Compilation {
  let key: string | null;
  try {
    key = JSON.stringify(row);
  } catch {
    // A row that will not serialise (a cycle, a BigInt) is compiled and not cached. It cannot
    // arrive from Postgres or from a corpus file; it can arrive from a test, and a test deserves an
    // answer rather than a throw from the cache layer.
    key = null;
  }
  if (key !== null) {
    const hit = COMPILED.get(key);
    if (hit !== undefined) return hit;
  }
  const built = compileUncached(row);
  if (key !== null) {
    if (COMPILED.size >= COMPILED_CAP) COMPILED.clear();
    COMPILED.set(key, built);
  }
  return built;
}

/** The compilation itself. Called only by `compileCard`, which caches it. */
function compileUncached(row: CardDataRow): Compilation {
  const printed = printedDef(row);
  if ('why' in printed) return { ok: false, why: printed.why };
  const def = printed.def;
  const typeLine = parseTypeLine(def.typeLine);
  const lines = printedRulesLines(row.oracle_text);

  /*
    A planeswalker with no starting loyalty this engine can read is refused outright rather than
    compiled, and so is a creature it cannot size — see `sizedBody` below for the creature, which
    has to wait until the text has been read. Both are the case where automating the card destroys
    it: the permanent arrives at zero and the state-based actions bin it (CR 704.5i, CR 704.5f)
    before anybody has priority, so there is no unread line left for a human to apply afterwards
    and D362's trade does not apply. Two of the corpus's 327 planeswalkers land here.
  */
  if (hasType(typeLine, 'planeswalker')) {
    const loyalty = printedLoyalty(def.name, row);
    if ('why' in loyalty) return { ok: false, why: loyalty.why };
  }

  /*
    `cardFromData` first, and its answer taken whole when it has one.

    Not a shortcut: when it succeeds it has read *every* line of the card, including the mana
    abilities and enters-tapped clauses this module has no reader for, and its script is the one the
    pool's hand-written twins were compared against in D331-D335. Re-deriving those cards here
    would be a second implementation of the same reading, free to disagree with the first.
  */
  const whole = cardFromData(row);
  if (whole.ok) {
    return {
      ok: true,
      def: whole.def,
      ...(whole.script === undefined ? {} : { script: whole.script }),
      compiled: lines,
      unread: [],
      source: 'whole-card',
      kind: whole.kind,
    };
  }

  /*
    A spell is the one card type whose text is not a list of independent abilities: every line of it
    belongs to one resolution, so it is compiled whole or not at all. See `spellScriptFor` — a
    spell whose second sentence went unread would resolve and silently do half of what it prints,
    with nothing flagged for anybody to notice.
  */
  if (hasType(typeLine, 'instant') || hasType(typeLine, 'sorcery')) {
    const spell = spellScriptFor(lines, def.name);
    return {
      ok: true,
      def,
      ...(spell.script === null
        ? {}
        : { script: { name: def.name, ...spell.script } as CardScript }),
      compiled: spell.compiled,
      unread: spell.unread.map((line) => ({ line, why: reasonFor(line) })),
      source: spell.script === null ? 'printed-only' : 'lines',
    };
  }

  const built: Record<string, unknown> = {};
  const compiled: string[] = [];
  const unread: UnreadLine[] = [];

  /*
    Some shapes are read from two lines at once, before the per-line loop.

    An Aura is the clearest case: `Enchant creature` on its own attaches and does nothing, and
    `Enchanted creature gets +2/+0` on its own is a bonus with nothing to attach it to — so neither
    line is a unit and the pair is. The same holds for "exile target X until ~ leaves the
    battlefield", whose exile and return are two triggers that are broken apart.

    `wholeCardShapeFor` returns every half or none of them, and names the lines it accounted for so
    they are not offered to the per-line readers afterwards. See its docblock for why emitting half
    would be worse than reading none of it.
  */
  const attachment = wholeCardShapeFor(def, lines);
  const claimed = new Set(attachment?.claimed ?? []);
  if (attachment !== null) {
    merge(built, attachment.fragment);
    compiled.push(...attachment.claimed);
  }

  for (const line of lines) {
    if (claimed.has(line)) continue;
    /*
      A printed ability line the engine already reads off the `CardDef` itself — `characteristicsOf`
      asks `printedKeywords`, `printedLandwalk` and `printedProtection` of the oracle text, with no
      script involved. So this counts as compiled and emits nothing: restating it in the script
      would be a second source for one fact.

      `isPrintedAbilityLine` rather than `printedKeywords` alone (D424): a line can be a mixed list
      — Phyrexian Crusader prints "First strike, protection from red, protection from white, infect"
      — and asking only about keywords reported River Boa's `Islandwalk` and Paladin en-Vec's
      protection as unread lines on cards the engine was already playing correctly.
    */
    if (isPrintedAbilityLine(line, def.name)) { compiled.push(line); continue; }

    const fragment = lineScriptFor(line, def.name);
    if (fragment === null) { unread.push({ line, why: reasonFor(line) }); continue; }
    if (merge(built, fragment) === 'conflict') {
      unread.push({ line, why: 'field-conflict' });
      continue;
    }
    compiled.push(line);
  }

  /*
    The size, now that the text has been read.

    A creature printed `*`/`*` has no size of its own — the number comes from a
    characteristic-defining ability — so whether the engine can play it depends on whether it read
    that ability, which is only known here. Lhurgoyf's count *is* read, and it is a 2/3 with two
    creature cards in a graveyard; Hand Goyf's is not, and dealing it would put a 0/0 on the
    battlefield for CR 704.5f to bin on arrival. So one is kept and the other refused.
  */
  if (hasType(typeLine, 'creature')) {
    const refusal = unsizeable(def.name, row, built.statics);
    if (refusal !== null) return { ok: false, why: refusal };
  }

  const anything = Object.keys(built).length > 0;
  return {
    ok: true,
    def,
    ...(anything ? { script: { name: def.name, ...built } as CardScript } : {}),
    compiled,
    unread,
    source: anything ? 'lines' : 'printed-only',
  };
}
