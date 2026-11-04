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
import { hasType, parseTypeLine, printedKeywords } from './characteristics.js';
import { cardFromData, printedDef, printedRulesLines, type CardDataRow, type DerivedKind } from './fromCardData.js';
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
 * Merges one keyword's fragment into the script being built.
 *
 * Triggers accumulate; every other field is set once. A second line setting an already-set field to
 * a different value is refused and reported, for the reason `UnreadLine.why` gives.
 */
function merge(
  into: Record<string, unknown>,
  fragment: Partial<CardScript>,
): 'merged' | 'conflict' {
  const entries = Object.entries(fragment);
  // Checked before anything is written, so a refused fragment leaves no half of itself behind.
  for (const [key, value] of entries) {
    if (key === 'triggers') continue;
    if (key in into && JSON.stringify(into[key]) !== JSON.stringify(value)) return 'conflict';
  }
  for (const [key, value] of entries) {
    if (key === 'triggers') {
      const existing = (into['triggers'] ?? []) as readonly unknown[];
      into['triggers'] = [...existing, ...(value as readonly unknown[])];
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

/**
 * Compiles one row of printed card data into as much of a `CardScript` as this engine can build.
 *
 * Refuses only what is not a single-face card at all — see `printedDef`. Everything else returns
 * `ok: true` with a `def`, whatever share of its text became rules, and the rest named.
 */
export function compileCard(row: CardDataRow): Compilation {
  const printed = printedDef(row);
  if ('why' in printed) return { ok: false, why: printed.why };
  const def = printed.def;
  const lines = printedRulesLines(row.oracle_text);

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
  const typeLine = parseTypeLine(def.typeLine);
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
      A keyword line the engine already reads off the `CardDef` itself — `characteristicsOf` calls
      `printedKeywords(def.oracleText)`, with no script involved. So this counts as compiled and
      emits nothing: restating it in the script would be a second source for one fact.
    */
    if (printedKeywords(line).length > 0) { compiled.push(line); continue; }

    const fragment = lineScriptFor(line, def.name);
    if (fragment === null) { unread.push({ line, why: reasonFor(line) }); continue; }
    if (merge(built, fragment) === 'conflict') {
      unread.push({ line, why: 'field-conflict' });
      continue;
    }
    compiled.push(line);
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
