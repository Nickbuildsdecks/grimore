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
  /** A creature with no text at all. */
  | 'vanilla-creature'
  /** A creature whose text is only keywords the engine implements. */
  | 'keyword-creature'
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
 * The mana a `{T}: Add …` line makes, or null when this module cannot read the line.
 *
 * Deliberately narrow. Two shapes are accepted and nothing else:
 *
 *  - `{T}: Add {G}.` — one symbol, one mana.
 *  - `{T}: Add {W}, {U}, {B}, {R}, or {G}.` — a choice of one, however many options are listed,
 *    including the two-option `{T}: Add {G} or {W}.` a dual land prints.
 *
 * A line adding **more than one** mana (`Add {C}{C}`, `Add {G}{G}`) is refused rather than
 * approximated, which is the Sol Ring case named in this file's header. A line with any other cost
 * — a life payment, an energy counter, a sacrifice, a mana cost — is refused because the cost is
 * part of the card and this parse does not model it.
 */
function parseManaLine(line: string): ManaType[] | null {
  const match = /^\{T\}:\s*Add\s+(.+?)\.?$/i.exec(line);
  if (match === null) return null;
  const body = match[1]!.trim();
  /*
    A choice of one of several. The separators are tried longest-first, because the printed list is
    an Oxford one — `{W}, {U}, {B}, {R}, or {G}` — and splitting on the bare comma before the
    `, or` leaves a trailing `or {G}` that then fails to parse as a symbol. The first draft of this
    had the alternatives the other way round, and a Command Tower was refused for it.
  */
  const parts = body.split(/\s*,\s*or\s+|\s*,\s*|\s+or\s+/i)
    .map((p) => p.trim()).filter((p) => p.length > 0);
  const produces: ManaType[] = [];
  for (const part of parts) {
    const symbol = /^\{([WUBRGC])\}$/i.exec(part);
    // More than one symbol in a single part means more than one mana: `Add {C}{C}`.
    if (symbol === null) return null;
    produces.push(MANA_SYMBOLS[symbol[1]!.toUpperCase()]!);
  }
  return produces.length === 0 ? null : produces;
}

/**
 * One tap ability per colour, rather than one ability producing several.
 *
 * The same reason the hand-written Guildgates are built this way: `manaSources` collapses several
 * free tap-for-mana abilities on one permanent into a single source that makes *one of* its
 * colours. A single ability listing both colours would be two mana off one land, and the engine
 * would start offering two-drops that cannot be cast.
 */
function tapAbilities(produces: readonly ManaType[]): AbilityDef[] {
  return produces.map((type) => ({
    cost: { tap: true },
    description: `{T}: Add {${type}}.`,
    produces: [type],
  }));
}

const INTEGER = /^\d+$/;

/** The layouts this module will read. Everything else has faces, and faces have their own rules. */
const SINGLE_FACE_LAYOUTS = new Set(['normal', 'leveler', 'saga', 'class', 'host', 'augment']);

/**
 * Builds a playable card out of a data row, or says why it cannot.
 *
 * Pure: no database, no network, no registry. The caller decides what to do with a rejection — the
 * table's answer is to keep that card as cardboard, which is what it does today for every name.
 */
export function cardFromData(row: CardDataRow): Derivation {
  const name = (row.name ?? '').trim();
  if (name === '') return { ok: false, why: 'the row has no name' };

  const typeLineText = (row.type_line ?? '').trim();
  if (typeLineText === '') return { ok: false, why: `${name}: the row has no type line` };

  const layout = (row.layout ?? 'normal').trim().toLowerCase();
  if (!SINGLE_FACE_LAYOUTS.has(layout)) {
    return { ok: false, why: `${name}: layout ${layout} has more than one face` };
  }

  const typeLine = parseTypeLine(typeLineText);
  const lines = rulesLines(row.oracle_text);
  const colors = list(row.colors).map((c) => c.toUpperCase());
  const cmcRaw = row.cmc;
  const cmc = typeof cmcRaw === 'number' ? cmcRaw : Number(cmcRaw ?? 0);

  const base = {
    name,
    typeLine: typeLineText,
    manaCost: (row.mana_cost ?? '').trim(),
    cmc: Number.isFinite(cmc) ? cmc : 0,
    oracleText: (row.oracle_text ?? '').trim(),
    colors,
    ...(row.image_uri ? { imageUri: row.image_uri } : {}),
    ...(row.id ? { scryfallId: row.id } : {}),
  };

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
    const parsed: ManaType[] = [];
    for (const line of lines) {
      if (isEntersTappedLine(line, name)) { entersTapped = true; continue; }
      const mana = parseManaLine(line);
      if (mana === null) {
        return { ok: false, why: `${name}: cannot read the line "${line}"` };
      }
      parsed.push(...mana);
    }

    /*
      The intrinsic ability of a basic land type, which is printed nowhere (CR 305.6). A Forest has
      no written abilities at all: its reminder text is dropped above, so `parsed` is empty and this
      is where its green mana comes from. A dual *typed* land — "Land — Forest Island" — gets both.
    */
    const intrinsic = basicTypes.map((s) => BASIC_LAND_MANA[s]!);
    const produces = [...new Set([...intrinsic, ...parsed])];
    if (produces.length === 0) {
      return { ok: false, why: `${name}: nothing in its data says what mana it makes` };
    }

    /*
      `produced_mana` as the cross-check. Scryfall says which colours the card can make; if the
      text this module read disagrees in either direction, this module has misread the card — a
      missing colour means an unparsed ability, and an extra one means a parse that invented mana.
    */
    const claimed = new Set(list(row.produced_mana).map((c) => c.toUpperCase()));
    if (claimed.size > 0) {
      const mine = new Set<string>(produces);
      const missing = [...claimed].filter((c) => !mine.has(c));
      const extra = [...mine].filter((c) => !claimed.has(c));
      if (missing.length > 0 || extra.length > 0) {
        return {
          ok: false,
          why: `${name}: the data says it makes [${[...claimed].sort().join('')}]`
            + ` and its text reads as [${[...mine].sort().join('')}]`,
        };
      }
    }

    return {
      ok: true,
      kind: basicTypes.length > 0 && parsed.length === 0 ? 'basic-land' : 'mana-source',
      def: base,
      script: {
        name,
        ...(entersTapped ? { entersTapped: true } : {}),
        abilities: tapAbilities(produces),
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
    const keywordLines = lines.filter((line) => printedKeywords(line).length > 0);
    const leftover = lines.filter((line) => !keywordLines.includes(line));
    if (leftover.length > 0) {
      return { ok: false, why: `${name}: cannot read the line "${leftover[0]}"` };
    }
    return { ok: true, kind: 'keyword-creature', def: withBody };
  }

  // ── Any other permanent ────────────────────────────────────────────────────────────────────────
  if (hasType(typeLine, 'artifact') || hasType(typeLine, 'enchantment') || hasType(typeLine, 'battle')) {
    if (lines.length > 0) return { ok: false, why: `${name}: cannot read the line "${lines[0]}"` };
    /*
      An Aura with no text would be an Aura that enchants nothing, which the engine models through
      `CardScript.aura` and cannot infer. A blank artifact or enchantment, meanwhile, really is a
      permanent that sits there — legal, occasionally printed, and nothing can go wrong with it.
    */
    if (typeLine.subtypes.some((s) => s.toLowerCase() === 'aura')) {
      return { ok: false, why: `${name}: an Aura has to say what it enchants` };
    }
    return { ok: true, kind: 'blank-permanent', def: base };
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
