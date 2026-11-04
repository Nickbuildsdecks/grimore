/**
 * A card built from its printed data, for the cards whose rules their data already is.
 *
 * ## The problem this is the first half of
 *
 * The engine knows 348 cards by hand, out of roughly thirty thousand legal in Commander. A pasted
 * list is matched against that pool and every miss becomes **cardboard** — a name and nothing else,
 * moved by hand (see `customDeck.ts`). That is the right answer for a card whose rules are a
 * paragraph of English. It is a waste for a Grizzly Bears.
 *
 * Because some cards carry no rules beyond what the data already says:
 *
 * - A **basic land** taps for its colour because of its subtype (CR 305.6). Nothing is written on
 *   a Forest at all; the reminder text in brackets is a reminder.
 * - A **vanilla creature** is a body. `2/2` is the whole card.
 * - A creature whose text is **only keywords** the engine already implements is a body with those
 *   keywords, and the engine can already read them: `printedKeywords` exists precisely so an
 *   unscripted card still flies.
 *
 * A probe written before this module settled what actually happens today, and two of its three
 * findings are why this file exists at all:
 *
 * 1. An unscripted vanilla creature **already works**. Cast, resolved, 2/2 on the battlefield,
 *    attacking the next turn, with no script and no change anywhere.
 * 2. An unscripted creature whose text is `Flying, vigilance` **already has both keywords**.
 * 3. An unscripted land **produces no mana whatsoever** — `manaSources` returned `[]` and the
 *    potential pool was all zeros, with `{T}: Add {G}.` printed on the card. The engine reads mana
 *    abilities off the script and nowhere else.
 *
 * So the gap is not the creatures. It is that a deck of data-derived cards cannot cast any of them,
 * because its lands do nothing. The mana ability is the one thing that has to be *built*, and it is
 * also the one thing the data states exactly. Hence this module.
 *
 * ## Parse the text; `produced_mana` is the cross-check, not the source
 *
 * Scryfall's `produced_mana` says **which** colours a permanent can make. It does not say how many,
 * at what cost, or how often. A Sol Ring produces `["C"]` and taps for **two**. Deriving one mana
 * from that field would ship a card that is wrong in the direction that loses games.
 *
 * So the ability is read from the oracle text, matched against a deliberately small set of printed
 * shapes, and `produced_mana` is then compared against what the parse produced. **A disagreement is
 * a rejection, not a merge.** If Scryfall says a card makes green and the text this module can read
 * does not mention green, this module does not understand the card.
 *
 * The Sol Ring is also why the *text* may state a quantity the field cannot: `{T}: Add {C}{C}.` is
 * read as two mana, because that is what it says. See `parseManaLine`, which corrects the first
 * draft's over-reading of this very paragraph.
 *
 * ## Mana that is not a land
 *
 * The same parse, on the same two shapes, wherever the ability is printed. A Llanowar Elves and a
 * Hagra Broodpit print the same line, and `manaSources` walks a permanent's abilities without
 * caring what type it is — so a mana dork is a body plus that ability (`mana-creature`) and a mana
 * rock is that ability on its own (`mana-source`). Both matter out of proportion to their share of
 * this project's own card pool, which holds one rock and two dorks: a real Commander list runs five
 * to fifteen of them, and a deck whose rocks are cardboard is a deck that cannot keep its curve.
 *
 * A creature is still a creature about it — it cannot be tapped the turn it arrives (CR 302.6) —
 * and that is the engine's rule, not anything this module does.
 *
 * ## Everything it will not do, and why that list is long on purpose
 *
 * This is a conservative classifier whose failure mode is "that card stays cardboard", which the
 * table already handles. The other failure mode — a card that looks automated and plays wrong — is
 * the one worth being afraid of, and it is the reason for every rejection below. Each one carries
 * its reason as text, because a count of what was rejected is useless for deciding what to script
 * next and a list of reasons is exactly the input for that.
 *
 * Notably refused:
 *
 * - **`*` or `X` in power, toughness or loyalty.** The probe is unambiguous here: a `*`/`*` creature
 *   cast with no script went straight to the graveyard, which is *correct* — its size comes from a
 *   characteristic-defining ability nobody can read, so it is a 0/0 and dies to CR 704.5f. A card
 *   that reliably dies on arrival is worse than a card you move by hand.
 * - **Any multi-face layout** (`split`, `adventure`, `modal_dfc`, `transform`, `flip`). Each has its
 *   own casting rules and the engine models them through `CardDef.faces`; a half-built one would be
 *   a card missing a mode.
 * - **Instants, sorceries, planeswalkers, and anything else whose text is its rules.** Their text is
 *   the card.
 * - **Any permanent with text this module cannot account for in full.** Not "mostly readable" — the
 *   leftover line is quoted in the rejection, so an unhandled shape is a finding rather than a
 *   silent approximation.
 */
import type { CardDef } from './cards.js';
import { parseTypeLine, hasType, printedKeywords } from './characteristics.js';
import { drawLater } from './effects.js';
import type { AbilityDef, CardScript } from './scriptTypes.js';
import type { ManaType } from './mana.js';

/**
 * A card row as the importer writes it, loosely typed because it crosses a database boundary.
 *
 * JSON columns arrive as strings (`scryfall_cards` stores them as TEXT — see migration 0015's
 * note), so every list field accepts either a parsed array or the string holding one. A caller
 * reading straight from Postgres should not have to normalise first, because a caller that has to
 * normalise first is a caller that will forget.
 */
export interface CardDataRow {
  readonly name?: string | null;
  readonly type_line?: string | null;
  readonly oracle_text?: string | null;
  readonly mana_cost?: string | null;
  readonly cmc?: number | string | null;
  readonly colors?: readonly string[] | string | null;
  readonly color_identity?: readonly string[] | string | null;
  readonly keywords?: readonly string[] | string | null;
  readonly power?: string | null;
  readonly toughness?: string | null;
  readonly loyalty?: string | null;
  readonly layout?: string | null;
  readonly produced_mana?: readonly string[] | string | null;
  readonly image_uri?: string | null;
  readonly id?: string | null;
  readonly oracle_id?: string | null;
}

/** Which shape of card the data turned out to be. Reported so a caller can say what it got. */
export type DerivedKind =
  /** A land with a basic land subtype: its mana ability is intrinsic (CR 305.6). */
  | 'basic-land'
  /** A land or artifact whose printed mana ability this module could read in full. */
  | 'mana-source'
  /** A creature that is a body *and* a mana source: a mana dork. */
  | 'mana-creature'
  /** A creature with no text at all. */
  | 'vanilla-creature'
  /** A creature whose text is only keywords the engine implements. */
  | 'keyword-creature'
  /**
   * A creature whose text is keywords, at least one of which carries a cost — morph, megamorph or
   * echo. See `keywordWithCost`, which also says where the line is drawn and why.
   */
  | 'costed-keyword-creature'
  /** A noncreature permanent with no text at all. Rare, and harmless. */
  | 'blank-permanent';

export type Derivation =
  | {
    readonly ok: true;
    readonly kind: DerivedKind;
    readonly def: CardDef;
    /** The script the card needs, or undefined when its data alone is enough. */
    readonly script?: CardScript;
  }
  | { readonly ok: false; readonly why: string };

/** The basic land types and what each one taps for (CR 305.6). */
const BASIC_LAND_MANA: Readonly<Record<string, ManaType>> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G', wastes: 'C',
};

const MANA_SYMBOLS: Readonly<Record<string, ManaType>> = {
  W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C',
};

/** A list column, from either a parsed array or the JSON string the database holds. */
function list(value: readonly string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (text === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Oracle text split into the lines that are rules.
 *
 * Reminder text in brackets is dropped, which is what makes a basic land's `({T}: Add {G}.)`
 * correctly read as a card with no written abilities rather than as a card with one.
 */
function rulesLines(oracleText: string | null | undefined): string[] {
  return (oracleText ?? '')
    .split('\n')
    .map((line) => line.replace(/\([^)]*\)/g, '').trim())
    .filter((line) => line.length > 0);
}

/** Whether a line is this card saying it arrives tapped. The name is allowed to vary. */
function isEntersTappedLine(line: string, name: string): boolean {
  /*
    Compared as text rather than with a regex built from the card's name, which is the kind of
    construction that goes wrong quietly: a name with a comma, an apostrophe or a hyphen in it —
    which is most legendary creatures — would need escaping, and an unescaped one matches the wrong
    thing instead of nothing. So the name is stripped off the front by length and the remainder is
    matched against the two printed wordings.
  */
  const self = line
    .replace(/^this (land|permanent|artifact|creature|enchantment)\b/i, name)
    .replace(/^~/, name)
    .trim();
  if (!self.toLowerCase().startsWith(name.toLowerCase())) return false;
  const rest = self.slice(name.length).trim().toLowerCase();
  return rest === 'enters tapped.' || rest === 'enters the battlefield tapped.';
}

/**
 * What a `{T}: Add …` line makes: a **choice** of one mana from a list, or a **sum** of several.
 *
 * The distinction is the whole reason this is a shape rather than a list of colours, and it is the
 * difference between a Guildgate and a Sol Ring. `manaSources` collapses several free tap-for-mana
 * abilities on one permanent into a single source that makes *one of* their colours, so a choice is
 * built as one ability per option and a sum is built as one ability producing several.
 */
interface ManaLine {
  readonly mode: 'choice' | 'sum';
  readonly produces: readonly ManaType[];
  /** What the ability costs, parsed from the text before the colon. */
  readonly cost: ManaAbilityCost;
  /**
   * The cost **exactly as printed** — `{T}`, `{T}, Pay 1 life`, `{T}, Sacrifice Lotus Petal`.
   *
   * Carried rather than rebuilt so the derived ability's `description` reads as the card does. It
   * also makes the comparison against a hand-written twin exact rather than approximate: the pool's
   * Lotus Petal describes its ability as `{T}, Sacrifice Lotus Petal: Add {W}.`, and a reconstructed
   * label would have had to guess between the card's name and `this artifact` — both of which are
   * printed, on different printings of the same card.
   */
  readonly printed: string;
}

/** A mana ability's cost, in the fields the engine's `AbilityCost` already has for them. */
interface ManaAbilityCost {
  readonly tap: true;
  readonly life?: number;
  readonly sacrificeSelf?: true;
}

/** `one mana of any color`, in both spellings this project has in its own card pool. */
const ANY_COLOUR = /^one\s+mana\s+of\s+any\s+colou?r$/i;

/** The five colours, in the printed order, for `Add one mana of any color`. */
const COLOURS: readonly ManaType[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * The extra clause in a mana ability's cost, in the two printed forms the engine already models.
 *
 * `{T}` alone is the common case and needs nothing. Beyond it:
 *
 *  - `Pay 1 life` — a pain land. `ManaSource.life` exists for exactly this and is carried through
 *    to whoever taps the source, so the solver knows what to charge.
 *  - `Sacrifice <this card>` — a Lotus Petal or a Treasure: one mana, once, and then it is gone.
 *    `sacrificeSelf` is the engine's field and `manaSources` already queues a consumed source
 *    behind the free ones.
 *
 * The self-reference is compared as text rather than against a regex built from the card's name,
 * for the reason `isEntersTappedLine` gives: most legendary names contain a comma or an apostrophe,
 * and an unescaped one matches the wrong thing rather than nothing. Both printed spellings are
 * accepted, because the same card prints each on different printings.
 */
function parseCostClause(clause: string, name: string): ManaAbilityCost | null {
  const life = /^Pay\s+(\d+)\s+life$/i.exec(clause);
  if (life !== null) {
    const amount = Number(life[1]);
    return amount > 0 ? { tap: true, life: amount } : null;
  }
  const sacrifice = /^Sacrifice\s+(.+)$/i.exec(clause);
  if (sacrifice === null) return null;
  const what = sacrifice[1]!.trim().toLowerCase();
  const self = what === name.toLowerCase()
    || /^this (artifact|permanent|land|creature|enchantment|token)$/.test(what);
  /*
    `Sacrifice a creature` is a cost this module must not read: it is a choice of which creature,
    made when the ability is activated, and nothing here models that. Only the card sacrificing
    itself is accepted.
  */
  return self ? { tap: true, sacrificeSelf: true } : null;
}

/** Two parsed costs that the engine would treat as the same cost. */
function sameCost(a: ManaAbilityCost, b: ManaAbilityCost): boolean {
  return (a.life ?? 0) === (b.life ?? 0)
    && (a.sacrificeSelf ?? false) === (b.sacrificeSelf ?? false);
}

/**
 * The mana a `{T}: Add …` line makes, or null when this module cannot read the line.
 *
 * Deliberately narrow. Four shapes of mana are accepted and nothing else:
 *
 *  - `{T}: Add {G}.` — one symbol, one mana.
 *  - `{T}: Add {W}, {U}, {B}, {R}, or {G}.` — a choice of one, however many options are listed,
 *    including the two-option `{T}: Add {G} or {W}.` a dual land prints.
 *  - `{T}: Add {C}{C}.` — several symbols in one run, which is a **sum**: a Sol Ring makes two.
 *  - `{T}: Add one mana of any color.` — the Birds of Paradise line, a choice of all five.
 *
 * ## The Sol Ring reasoning, corrected
 *
 * The first draft of this function refused every line adding more than one mana, and said so by
 * naming "the Sol Ring case named in this file's header". That was the wrong read of its own
 * header. The header's objection is to deriving an ability from **`produced_mana`**, which says
 * *which* colours a permanent makes and not how many — and a Sol Ring is the example *because*
 * `["C"]` would have produced a card that taps for one when the card taps for two.
 *
 * That is an argument about the field, and this function does not read the field. `{T}: Add {C}{C}.`
 * states the quantity exactly, in the text, and the engine has carried `produces: ['C', 'C']` since
 * the mana solver was written — the hand-written Sol Ring in the pool is exactly that one line. So
 * the sum is as exact as the single symbol, and refusing it was an over-reading of a good rule.
 * `produced_mana` remains the cross-check, where a set comparison is all it can honestly support.
 *
 * ## What is still refused, and why each one is a card and not an oversight
 *
 * A cost this module cannot read is still a refusal — an energy counter, a mana payment, a
 * sacrifice of something other than the card itself, a counter removed. The cost is part of the
 * card, and the two clauses `parseCostClause` does read are there because the engine already has a
 * field for each: a pain land's life and a Lotus Petal's own body. Mind Stone's second ability
 * (`{1}, {T}, Sacrifice Mind Stone: Draw a card.`) is refused for a different reason entirely — it
 * is not a mana ability at all, and half of that card is not the card.
 *
 * Only **one** extra clause is read. `{T}, Pay 1 life, Sacrifice this: …` would be two, and a cost
 * this parse half-reads is worse than one it refuses.
 *
 * A **mixture** of a sum and a choice (`Add {G}{G} or {W}`) is refused as well. Nothing in this
 * pool prints one, the shape is rare enough in Magic that a reader meeting it here would be right
 * to be suspicious of a parse that guessed, and the merge rule it would need at the call site is
 * the kind of thing that is wrong in one direction without anybody noticing.
 */
function parseManaLine(line: string, name: string): ManaLine | null {
  const match = /^(\{T\}(?:,\s*[^:]+)?):\s*Add\s+(.+?)\.?$/i.exec(line);
  if (match === null) return null;
  const printed = match[1]!.trim();
  const body = match[2]!.trim();

  const clauses = printed.split(/\s*,\s*/).slice(1).map((c) => c.trim()).filter((c) => c !== '');
  if (clauses.length > 1) return null;
  let cost: ManaAbilityCost = { tap: true };
  if (clauses.length === 1) {
    const extra = parseCostClause(clauses[0]!, name);
    if (extra === null) return null;
    cost = extra;
  }

  // `one mana of any color` — checked first, because it contains none of the symbols below.
  if (ANY_COLOUR.test(body)) return { mode: 'choice', produces: COLOURS, cost, printed };

  /*
    A choice of one of several. The separators are tried longest-first, because the printed list is
    an Oxford one — `{W}, {U}, {B}, {R}, or {G}` — and splitting on the bare comma before the
    `, or` leaves a trailing `or {G}` that then fails to parse as a symbol. The first draft of this
    had the alternatives the other way round, and a Command Tower was refused for it.
  */
  const parts = body.split(/\s*,\s*or\s+|\s*,\s*|\s+or\s+/i)
    .map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const read = parts.map(parseSymbolRun);
  if (read.some((r) => r === null)) return null;
  const runs = read as ManaType[][];

  /*
    One part holding several symbols is a sum: `Add {C}{C}`. Several parts are a choice, and every
    one of them has to be a single symbol — a part with a run in it would be the mixture refused
    above.
  */
  if (runs.length === 1) {
    const only = runs[0]!;
    return { mode: only.length > 1 ? 'sum' : 'choice', produces: only, cost, printed };
  }
  if (runs.some((r) => r.length !== 1)) return null;
  return { mode: 'choice', produces: runs.map((r) => r[0]!), cost, printed };
}

/** A run of mana symbols with nothing else in it: `{C}{C}`, `{G}`. Null for anything else. */
function parseSymbolRun(part: string): ManaType[] | null {
  if (!/^(?:\{[WUBRGC]\})+$/i.test(part)) return null;
  return [...part.matchAll(/\{([WUBRGC])\}/gi)]
    .map((m) => MANA_SYMBOLS[m[1]!.toUpperCase()]!);
}

/**
 * One tap ability per colour, rather than one ability producing several.
 *
 * The same reason the hand-written Guildgates are built this way: `manaSources` collapses several
 * free tap-for-mana abilities on one permanent into a single source that makes *one of* its
 * colours. A single ability listing both colours would be two mana off one land, and the engine
 * would start offering two-drops that cannot be cast.
 */
function tapAbilities(produces: readonly ManaType[], line?: ManaLine): AbilityDef[] {
  const cost = line?.cost ?? { tap: true as const };
  const printed = line?.printed ?? '{T}';
  return produces.map((type) => ({
    cost,
    description: `${printed}: Add {${type}}.`,
    produces: [type],
  }));
}

/** The one ability a sum line buys: one tap, several mana, exactly as the hand-written Sol Ring. */
function sumAbility(line: ManaLine): AbilityDef {
  return {
    cost: line.cost,
    description: `${line.printed}: Add ${line.produces.map((t) => `{${t}}`).join('')}.`,
    produces: [...line.produces],
  };
}

/**
 * Every mana line on one permanent, folded into the abilities it should have.
 *
 * `intrinsic` is the mana a basic land type grants with nothing printed (CR 305.6), which is always
 * a choice. The rule for mixing is the conservative one: a sum line has to be the only mana the
 * permanent makes, because merging "taps for two colourless" with "taps for green" needs a
 * judgement about what the card does that this module has no way to make.
 *
 * Lines whose **costs** differ are refused for the same reason. A permanent with one free tap and
 * one that costs a life is making a choice this module would have to flatten into a single cost,
 * and flattening it in either direction prices the card wrong: free when it is not, or painful when
 * it need not be.
 */
function foldManaLines(
  name: string,
  intrinsic: readonly ManaType[],
  parsed: readonly ManaLine[],
): { abilities: AbilityDef[]; produces: ManaType[] } | { why: string } {
  const sums = parsed.filter((p) => p.mode === 'sum');
  if (sums.length > 0) {
    if (parsed.length > 1 || intrinsic.length > 0) {
      return { why: `${name}: it adds several mana and also adds mana some other way` };
    }
    const only = sums[0]!;
    return { abilities: [sumAbility(only)], produces: [...new Set(only.produces)] };
  }

  const first = parsed[0];
  if (first !== undefined && parsed.some((p) => !sameCost(p.cost, first.cost))) {
    return { why: `${name}: its mana abilities do not all cost the same` };
  }
  /*
    An intrinsic basic land type is free, so a printed ability that costs something cannot be folded
    in with it: a `Land — Swamp` that also taps for a life would be two different sources, and this
    builds one. Nothing prints that; it is refused rather than left to be discovered.
  */
  if (first !== undefined && intrinsic.length > 0 && !sameCost(first.cost, { tap: true })) {
    return { why: `${name}: a basic land type is free and its printed ability is not` };
  }
  const produces = [...new Set<ManaType>([
    ...intrinsic,
    ...parsed.flatMap((p) => [...p.produces]),
  ])];
  return { abilities: tapAbilities(produces, first), produces };
}

/**
 * `produced_mana` as the cross-check, for every branch that reads a mana ability.
 *
 * Scryfall says which colours the card can make; if the text this module read disagrees in either
 * direction, this module has misread the card — a missing colour means an unparsed ability, and an
 * extra one means a parse that invented mana. The comparison is of **sets**, which is the most the
 * field can honestly support: it does not say how many, so it cannot confirm a sum.
 */
function manaMismatch(
  name: string,
  produces: readonly ManaType[],
  claimedRaw: readonly string[],
): string | null {
  const claimed = new Set(claimedRaw.map((c) => c.toUpperCase()));
  if (claimed.size === 0) return null;
  const mine = new Set<string>(produces);
  const missing = [...claimed].filter((c) => !mine.has(c));
  const extra = [...mine].filter((c) => !claimed.has(c));
  if (missing.length === 0 && extra.length === 0) return null;
  return `${name}: the data says it makes [${[...claimed].sort().join('')}]`
    + ` and its text reads as [${[...mine].sort().join('')}]`;
}

/**
 * A keyword line that is nothing but the keyword and a mana cost, parsed into the script field the
 * engine already reads for it.
 *
 * `scripts/measure/derivable.mjs` named this family. `printedKeywords` recognises a keyword as a
 * bare word, so `Flying` is read and `Morph {1}{G}` is not — it reads as a line with rules in it
 * and the card is refused. But morph, megamorph and echo are **fully implemented mechanics whose
 * only card-specific parameter is a cost**, and the cost is the one thing printed data states
 * exactly. That makes them the same shape of derivation as the mana ability and not the same shape
 * as anything below.
 *
 * ## The line this family is on, and why cycling is on the other side of it
 *
 * The next buckets the measurement names are "When ~ enters the battlefield, you gain 2 life" and
 * its twenty-odd siblings, and plain `Cycling {2}`. Those are **not** done here, and the reason is
 * worth stating because it is a rule rather than a backlog item:
 *
 * A morph cost is *data*. The engine already knows what morph does; the card supplies a number.
 * Nothing is being inferred, so nothing can be inferred wrongly — a misparse is a refusal, and the
 * tests below check both directions. "You gain 2 life" is *English*, and turning English into an
 * effect is the direction in which a card silently does less than it reads: no error, no failing
 * test, and a player loses a game to the engine rather than to their own misreading. This project
 * already has that rule written down for card text ("inventing the text of a real card is worse
 * than leaving the mechanic out") and this is its sibling: **inventing the effect of a real card is
 * worse than leaving it cardboard.**
 *
 * **Cycling is now done too, and the reason it was left out first was weaker than it sounded.** The
 * objection was that it needs an ability with an `effect` function rather than a data field, so
 * this module would have to reach into `effects.js`, and "a derived ability that runs code is a
 * different commitment from one that states a cost".
 *
 * That conflates two things. Cycling's effect is not inferred from the card's English: CR 702.29a
 * *defines* cycling as "Discard this card: Draw a card", so the only card-specific parameter is the
 * cost — exactly as with morph. Whether the engine happens to implement the mechanic as a script
 * field or as an ability carrying a function is a fact about the engine, not about how much is
 * being guessed. Nothing is guessed either way.
 *
 * It is also where the value is. Five of the eleven lands the pool refuses are cycling lands, so
 * teaching this moves lands from 61% to roughly 79% — and lands are where the measured share lives
 * (D332). The line that still holds is the one below it: "When this enters, you gain 2 life" is
 * English, and no keyword defines it.
 */
function keywordWithCost(line: string): { field: 'morph' | 'echo'; mana: string; mega?: true } | null {
  const match = /^(Morph|Megamorph|Echo)\s+((?:\{[^}]*\})+)$/i.exec(line.trim());
  if (match === null) return null;
  const word = match[1]!.toLowerCase();
  const mana = match[2]!;
  /*
    `Morph — Pay 3 life.` is in this pool and is deliberately not matched: the field takes an
    `AbilityCost` precisely because a morph cost is not always mana, but a cost this reader cannot
    parse is a cost it must not guess at. The regex requires mana symbols and nothing else.
  */
  if (word === 'echo') return { field: 'echo', mana };
  return word === 'megamorph' ? { field: 'morph', mana, mega: true } : { field: 'morph', mana };
}

/**
 * `Cycling {2}` — the cost of the one ability every cycling card has (CR 702.29a).
 *
 * Typeless cycling only. The printed variants that cycle for a *kind* of card — landcycling,
 * basic landcycling, "Swampcycling {2}" — search a library instead of drawing, which is a
 * different ability and a different prompt, so they are not matched and the card is refused.
 */
function cyclingCost(line: string): string | null {
  const match = /^Cycling\s+((?:\{[^}]*\})+)$/i.exec(line.trim());
  return match === null ? null : match[1]!;
}

/**
 * The ability a cycling cost buys, built the same way the hand-written cycling lands build theirs.
 *
 * `discardSelf` in the cost is what makes `legalActions` offer it from the **hand** rather than the
 * battlefield, which is the whole of the card: a land that is never a dead draw because its
 * late-game version is a cantrip.
 */
function cyclingAbility(cost: string): AbilityDef {
  return {
    cost: { mana: cost, discardSelf: true },
    description: `Cycling ${cost} (${cost}, Discard this card: Draw a card.)`,
    effect: (c) => drawLater(c.state, c.controller, 1),
  };
}

const INTEGER = /^\d+$/;

/** The layouts this module will read. Everything else has faces, and faces have their own rules. */
const SINGLE_FACE_LAYOUTS = new Set(['normal', 'leveler', 'saga', 'class', 'host', 'augment']);

/**
 * Layouts that are not cards: tokens, emblems, art series, memorabilia.
 *
 * Refused with their own reason, which is the point. **They used to fall through to the multi-face
 * check and be refused as "layout token has more than one face"** — found by running the `--file`
 * arm of `scripts/measure/derivable.mjs` for the first time against a fixture with a token in it.
 * A token has exactly one face. The message was simply false, and on a real `oracle_cards` file —
 * which lists tokens as their own entries — it would have been false thousands of times, which is
 * the kind of thing that sends the next reader looking for a multi-face bug that does not exist.
 */
const NOT_CARDS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'memorabilia']);

/**
 * Builds a playable card out of a data row, or says why it cannot.
 *
 * Pure: no database, no network, no registry. The caller decides what to do with a rejection — the
 * table's answer is to keep that card as cardboard, which is what it does today for every name.
 */
/**
 * The printed data as a `CardDef`, with no judgement at all about whether the engine can play it.
 *
 * Split out of `cardFromData` for the oracle-text compiler (#317), and the split is the point.
 * `cardFromData` answers one question — *is this card's text nothing but its data?* — and returns
 * `ok: false` the moment the answer is no, which it is for every instant, every planeswalker and
 * every creature with a paragraph. The compiler asks a different question: *how much of this card's
 * text can be turned into rules, and which lines could not?* It needs the printed data for a card
 * whose text it only partly reads, which is most cards, so the two questions cannot share one
 * all-or-nothing return.
 *
 * The four refusals kept here are the ones that mean **this row is not a single-face card at all**,
 * where there is no `CardDef` to hand back rather than a `CardDef` with unread text. Everything
 * past this point in `cardFromData` is the narrower question and belongs to it.
 */
export function printedDef(row: CardDataRow): { readonly def: CardDef } | { readonly why: string } {
  const name = (row.name ?? '').trim();
  if (name === '') return { why: 'the row has no name' };

  const typeLineText = (row.type_line ?? '').trim();
  if (typeLineText === '') return { why: `${name}: the row has no type line` };

  const layout = (row.layout ?? 'normal').trim().toLowerCase();
  if (NOT_CARDS.has(layout)) {
    return { why: `${name}: a ${layout.replace(/_/g, ' ')} is not a card` };
  }
  if (!SINGLE_FACE_LAYOUTS.has(layout)) {
    return { why: `${name}: layout ${layout} has more than one face` };
  }

  const colors = list(row.colors).map((c) => c.toUpperCase());
  const cmcRaw = row.cmc;
  const cmc = typeof cmcRaw === 'number' ? cmcRaw : Number(cmcRaw ?? 0);

  return {
    def: {
      name,
      typeLine: typeLineText,
      manaCost: (row.mana_cost ?? '').trim(),
      cmc: Number.isFinite(cmc) ? cmc : 0,
      oracleText: (row.oracle_text ?? '').trim(),
      colors,
      ...(row.image_uri ? { imageUri: row.image_uri } : {}),
      ...(row.id ? { scryfallId: row.id } : {}),
    },
  };
}

/** The rules lines of a card's text, reminder text stripped. Shared with the compiler (#317). */
export function printedRulesLines(oracleText: string | null | undefined): readonly string[] {
  return rulesLines(oracleText);
}

export function cardFromData(row: CardDataRow): Derivation {
  const printed = printedDef(row);
  if ('why' in printed) return { ok: false, why: printed.why };
  const base = printed.def;
  const name = base.name;
  const typeLineText = base.typeLine;

  const typeLine = parseTypeLine(typeLineText);
  const lines = rulesLines(row.oracle_text);

  // ── Planeswalkers and the cards whose text is their rules ──────────────────────────────────────
  if (hasType(typeLine, 'planeswalker')) {
    return { ok: false, why: `${name}: a planeswalker's loyalty abilities are its text` };
  }
  if (hasType(typeLine, 'instant') || hasType(typeLine, 'sorcery')) {
    return { ok: false, why: `${name}: an instant or sorcery is nothing but what its text does` };
  }

  // ── Lands and other mana sources ───────────────────────────────────────────────────────────────
  const isLand = hasType(typeLine, 'land');
  const basicTypes = typeLine.subtypes
    .map((s) => s.toLowerCase())
    .filter((s) => s in BASIC_LAND_MANA);

  if (isLand || basicTypes.length > 0) {
    /*
      A land's text is read in full, and only two kinds of line are allowed through: a mana ability
      this module can parse, and the card saying it enters tapped. Anything else is the card doing
      something, and a land that does something is a land this module does not understand.
    */
    let entersTapped = false;
    let cycling: string | null = null;
    let landMorph: { readonly cost: { readonly mana: string }; readonly mega?: true } | undefined;
    const parsed: ManaLine[] = [];
    for (const line of lines) {
      if (isEntersTappedLine(line, name)) { entersTapped = true; continue; }
      const cycle = cyclingCost(line);
      if (cycle !== null && cycling === null) { cycling = cycle; continue; }
      /*
        `Morph {2}` on a land, which is a Zoetic Cavern: a land you may instead cast face down as a
        2/2. The same reading the creature branch does, and allowed here because the mechanic is
        fully implemented and the card supplies only a cost — the pool's hand-written twin is this
        land's mana ability plus `morph: { cost: { mana: '{2}' } }` and nothing else.
      */
      const costed = keywordWithCost(line);
      if (costed !== null && costed.field === 'morph' && landMorph === undefined) {
        landMorph = costed.mega === true
          ? { cost: { mana: costed.mana }, mega: true }
          : { cost: { mana: costed.mana } };
        continue;
      }
      const mana = parseManaLine(line, name);
      if (mana === null) {
        return { ok: false, why: `${name}: cannot read the line "${line}"` };
      }
      parsed.push(mana);
    }

    /*
      The intrinsic ability of a basic land type, which is printed nowhere (CR 305.6). A Forest has
      no written abilities at all: its reminder text is dropped above, so `parsed` is empty and this
      is where its green mana comes from. A dual *typed* land — "Land — Forest Island" — gets both.
    */
    const intrinsic = basicTypes.map((s) => BASIC_LAND_MANA[s]!);
    const folded = foldManaLines(name, intrinsic, parsed);
    if ('why' in folded) return { ok: false, why: folded.why };
    if (folded.produces.length === 0) {
      return { ok: false, why: `${name}: nothing in its data says what mana it makes` };
    }

    /*
      `produced_mana` as the cross-check. Scryfall says which colours the card can make; if the
      text this module read disagrees in either direction, this module has misread the card — a
      missing colour means an unparsed ability, and an extra one means a parse that invented mana.
    */
    const mismatch = manaMismatch(name, folded.produces, list(row.produced_mana));
    if (mismatch !== null) return { ok: false, why: mismatch };

    return {
      ok: true,
      kind: basicTypes.length > 0 && parsed.length === 0 ? 'basic-land' : 'mana-source',
      def: base,
      script: {
        name,
        ...(entersTapped ? { entersTapped: true } : {}),
        ...(landMorph === undefined ? {} : { morph: landMorph }),
        /*
          Mana first, cycling after, matching the hand-written cycling lands. `manaSources` only
          looks at abilities with `produces`, so the order does not change what it finds — but a
          script a reader can compare to its hand-written twin is worth more than one they cannot.
        */
        abilities: cycling === null
          ? folded.abilities
          : [...folded.abilities, cyclingAbility(cycling)],
      },
    };
  }

  // ── Creatures ──────────────────────────────────────────────────────────────────────────────────
  if (hasType(typeLine, 'creature')) {
    const power = (row.power ?? '').trim();
    const toughness = (row.toughness ?? '').trim();
    if (power === '' || toughness === '') {
      return { ok: false, why: `${name}: a creature with no printed power or toughness` };
    }
    /*
      `*`, `1+*` and `?` are printed values and the columns hold them (migration 0015 types them
      TEXT for exactly that reason) — but a size that comes from a characteristic-defining ability
      is a size this module cannot compute. The probe settled what happens if it ships anyway: the
      creature is a 0/0 and dies the instant it arrives (CR 704.5f). Cardboard is strictly better.
    */
    if (!INTEGER.test(power) || !INTEGER.test(toughness)) {
      return { ok: false, why: `${name}: its ${power}/${toughness} comes from an ability, not a number` };
    }

    const withBody = { ...base, power, toughness };
    if (lines.length === 0) return { ok: true, kind: 'vanilla-creature', def: withBody };

    /*
      Keyword-only text. `printedKeywords` already reads these off an unscripted card, so the whole
      job here is deciding whether the text is *nothing but* keyword lines: it accepts a line only
      when every comma-separated part of it is a keyword it knows, so a line it skipped is a line
      with rules in it.
    */
    let morph: { readonly cost: { readonly mana: string }; readonly mega?: true } | undefined;
    let echo: { readonly cost: string } | undefined;
    const mana: ManaLine[] = [];
    const unread: string[] = [];
    for (const line of lines) {
      if (printedKeywords(line).length > 0) continue;
      /*
        A mana dork. The ability is read exactly as a land's is — same parser, same cross-check
        below — because a Llanowar Elves and a Hagra Broodpit print the same line, and the engine
        makes no distinction either: `manaSources` walks the abilities on a permanent without
        caring what type it is. The one thing it does know is that a creature cannot be tapped the
        turn it arrives (CR 302.6), which is the whole difference between a dork and a land and is
        already handled.
      */
      const dork = parseManaLine(line, name);
      if (dork !== null) { mana.push(dork); continue; }
      const costed = keywordWithCost(line);
      if (costed === null) { unread.push(line); continue; }
      // A card printing the same costed keyword twice is a card this has not seen; refuse it
      // rather than silently keeping the second one.
      if (costed.field === 'echo') {
        if (echo !== undefined) { unread.push(line); continue; }
        echo = { cost: costed.mana };
      } else {
        if (morph !== undefined) { unread.push(line); continue; }
        morph = costed.mega === true
          ? { cost: { mana: costed.mana }, mega: true }
          : { cost: { mana: costed.mana } };
      }
    }
    if (unread.length > 0) {
      return { ok: false, why: `${name}: cannot read the line "${unread[0]}"` };
    }
    if (morph === undefined && echo === undefined && mana.length === 0) {
      return { ok: true, kind: 'keyword-creature', def: withBody };
    }

    const dorkMana = mana.length === 0 ? null : foldManaLines(name, [], mana);
    if (dorkMana !== null && 'why' in dorkMana) return { ok: false, why: dorkMana.why };
    if (dorkMana !== null) {
      const mismatch = manaMismatch(name, dorkMana.produces, list(row.produced_mana));
      if (mismatch !== null) return { ok: false, why: mismatch };
    }

    return {
      ok: true,
      kind: dorkMana === null ? 'costed-keyword-creature' : 'mana-creature',
      def: withBody,
      script: {
        name,
        ...(morph === undefined ? {} : { morph }),
        ...(echo === undefined ? {} : { echo }),
        ...(dorkMana === null ? {} : { abilities: dorkMana.abilities }),
      },
    };
  }

  // ── Any other permanent ────────────────────────────────────────────────────────────────────────
  if (hasType(typeLine, 'artifact') || hasType(typeLine, 'enchantment') || hasType(typeLine, 'battle')) {
    /*
      An Aura with no text would be an Aura that enchants nothing, which the engine models through
      `CardScript.aura` and cannot infer. A blank artifact or enchantment, meanwhile, really is a
      permanent that sits there — legal, occasionally printed, and nothing can go wrong with it.
    */
    if (typeLine.subtypes.some((s) => s.toLowerCase() === 'aura')) {
      return { ok: false, why: `${name}: an Aura has to say what it enchants` };
    }
    if (lines.length === 0) return { ok: true, kind: 'blank-permanent', def: base };

    /*
      A mana rock, read with the land's parser. This branch used to refuse any text at all, which
      meant a Sol Ring — one line, a quantity stated exactly, and a hand-written twin in this pool
      that is that line and nothing else — was cardboard. Every other line is still a refusal, so
      a Mind Stone (a rock whose second ability sacrifices it for a card) stays cardboard, which is
      correct: half of that card is not the card.
    */
    const rock: ManaLine[] = [];
    for (const line of lines) {
      const parsedLine = parseManaLine(line, name);
      if (parsedLine === null) return { ok: false, why: `${name}: cannot read the line "${line}"` };
      rock.push(parsedLine);
    }
    const folded = foldManaLines(name, [], rock);
    if ('why' in folded) return { ok: false, why: folded.why };
    const mismatch = manaMismatch(name, folded.produces, list(row.produced_mana));
    if (mismatch !== null) return { ok: false, why: mismatch };

    return {
      ok: true,
      kind: 'mana-source',
      def: base,
      script: { name, abilities: folded.abilities },
    };
  }

  return { ok: false, why: `${name}: ${typeLineText} is not a card shape this reads` };
}

/*
  There was a `tallyDerivations(rows)` here, and it is gone on purpose.

  It counted a batch by kind and collected the refusal reasons — the obvious companion to
  `cardFromData`, and exactly the shape of API that gets written because it seems like it will be
  wanted. Nothing wanted it. `scripts/measure/derivable.mjs` needs the share **by card type** and
  the refused lines **grouped by what they open with**, because those are the two readings that are
  actually useful, and neither belongs in this package: they are how a report is laid out, not what
  a card is. So the script walks `cardFromData` itself and `tallyDerivations` had exactly one
  caller, its own test.

  A test over an export nobody calls is the same thing this session has spent the day finding: it
  passes, it is green, and the only thing it proves is that the speculation compiles. Deleted rather
  than left for the next reader to wonder whether something depends on it. The real "what did this
  list derive" answer is `CustomDeckResult.fromData`, which a caller does read.
*/
