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
import type { CardDef, CardFaces } from './cards.js';
import { costValue, parseManaCost } from './mana.js';
import { hasType, isCreatureType, isPrintedAbilityLine, parseTypeLine, printedKeywords, LEVEL_BAND_HEADER } from './characteristics.js';
import {
  cardFromData, intrinsicManaAbilities, isManaAbilityLine, manaAbilitiesFromLine, printedBody, printedDef,
  printedLoyalty, printedRulesLines,
  type CardDataRow, type CardFaceRow, type DerivedKind,
} from './fromCardData.js';
import {
  cardNameDecision, championTriggers, classLevelAbility, embalm, enterChoiceDecision, eternalize, isKeywordDeclaration, levelUpAbility, lineScriptFor, withXPayable,
  manaSpentScryTrigger, modalTriggerFor, modalAbilityFor, dieTableFor, spellScriptFor, stationAbility, wholeCardShapeFor, type ChoiceAim,
} from './scripts.js';
import type { AbilityDef, CardScript, TriggerDef } from './scriptTypes.js';
import { CHOSEN_COLOR, CHOSEN_TYPE, KICKED, copyAsToken, pump } from './effects.js';

/**
 * Which choice a card asks as it enters (D641), off its printed lines: a creature type, a colour, or
 * none — and the colour it may not be, for "a color other than green" (D642).
 */
function enterChoiceOf(lines: readonly string[]): { kind: 'creature-type' | 'color'; except?: string } | null {
  for (const line of lines) {
    const m = /^(?:.+ enters tapped\. )?As .+ enters(?: the battlefield)?, choose an? (creature type|color)(?: other than (white|blue|black|red|green))?\.?$/i.exec(line.trim());
    if (m !== null) {
      return {
        kind: m[1]!.toLowerCase() === 'color' ? 'color' : 'creature-type',
        ...(m[2] === undefined ? {} : { except: m[2].toLowerCase() }),
      };
    }
  }
  return null;
}

/** Which choice a line's fragment reads (D641): "the chosen type", "the chosen color", or neither. */
function choiceReadBy(fragment: Partial<CardScript>): 'creature-type' | 'color' | null {
  const json = JSON.stringify(fragment.statics ?? []);
  // A trigger's event is plain data, so "…a spell of the chosen color" shows in it too (D643).
  const events = JSON.stringify((fragment.triggers ?? []).map((t) => t.on));
  if (json.includes(JSON.stringify(CHOSEN_TYPE)) || events.includes('"ofChosen":"type"')) return 'creature-type';
  if (json.includes('"chosenColor"') || json.includes(JSON.stringify(CHOSEN_COLOR)) || events.includes('"ofChosen":"color"')) return 'color';
  return null;
}

/**
 * Which way the bot's answer should point (D641): at an opponent's tribe when a chosen-type static
 * shrinks or locks creatures, away from the colour a protection static names, otherwise at the
 * controller's own deck.
 */
function choiceAimOf(statics: CardScript['statics'], triggers?: CardScript['triggers']): ChoiceAim {
  /*
    A cast trigger that watches **other players'** spells of the chosen colour or type (D643) —
    Curse of Wizardry's "that player loses 1 life", Jeweled Torque's tax — is pointed at what the
    opponents cast. Naming its own controller's colour would make Curse of Wizardry a curse on them.
  */
  for (const trigger of triggers ?? []) {
    if (trigger.on.kind === 'spell-cast' && trigger.on.ofChosen !== undefined && (trigger.on.by ?? 'you') !== 'you') {
      return 'hostile';
    }
  }
  for (const entry of statics ?? []) {
    if (entry.chosenColor === 'protection') return 'protection';
    const chosenScope = typeof entry.scope === 'object'
      && (('subtype' in entry.scope && entry.scope.subtype === CHOSEN_TYPE)
        || ('color' in entry.scope && entry.scope.color === CHOSEN_COLOR));
    if (chosenScope) {
      const e = entry.effect;
      if ((e.power ?? 0) < 0 || (e.toughness ?? 0) < 0 || e.doesntUntap === true || e.cantBlock === true || e.cantAttack === true) {
        return 'hostile';
      }
    }
  }
  return 'friendly';
}
import type { LevelBand } from './cards.js';
import type { GameState } from './types.js';

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
 *
 * And `costModifiers` (D1229), a list for the same reason: Grand Arbiter Augustin IV prints three
 * of them on three lines ("White spells you cast cost {1} less", "Blue spells …", "Spells your
 * opponents cast cost {1} more"), and the second was refused as a conflict with the first.
 */
const ACCUMULATING = new Set(['triggers', 'abilities', 'statics', 'costModifiers']);

/**
 * Merges one line's fragment into the script being built.
 *
 * Abilities accumulate; every other field is set once. A second line setting an already-set field
 * to a different value is refused and reported, for the reason `UnreadLine.why` gives.
 */
/**
 * A keyword list with ward in it, as the ward triggers it needs (D659), or `null` when the line is
 * not one: at least one other part, every other part a printed part, and every ward part read.
 */
function wardInList(line: string, name: string): Partial<CardScript> | null {
  const parts = line.replace(/\([^)]*\)/g, '').split(/[,;]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const wards = parts.filter((part) => /^ward\b/i.test(part));
  if (wards.length === 0) return null;
  if (!parts.every((part) => /^ward\b/i.test(part) || isPrintedAbilityLine(part, name))) return null;
  const triggers: NonNullable<CardScript['triggers']>[number][] = [];
  for (const part of wards) {
    const read = lineScriptFor(part, name);
    if (read === null || Object.keys(read).some((key) => key !== 'triggers')) return null;
    triggers.push(...(read.triggers ?? []));
  }
  return { triggers };
}

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
 * **A leveler's bands, read** (D636, CR 711).
 *
 * `levelBands` and `levelUpAbility` have carried Student of Warfare and Beastbreaker since D572; what
 * was missing was a reader, so all 26 legal levelers were unread from their first `LEVEL` header
 * down. The card's text is the header line "Level up {cost}", then bands: `LEVEL n-m` or `LEVEL n+`,
 * a size line, and the lines the creature has while in that band (CR 711.2).
 *
 * - A line that is **only keywords** goes on the band (`LevelBand.keywords`), which is where
 *   `characteristicsOf` already looks.
 * - Any other line is read by the ordinary line reader and then **scoped to the band**: an activated
 *   ability gets an `activateOnlyIf` on the level count, a trigger a `condition`, and a static a
 *   `source-has-counter` `while` with its upper edge. Brimstone Mage's 1-damage ping exists only at
 *   levels 1-2 and its 3-damage one only at 3+, which is the card.
 * - Anything else — a line no reader has, a static that already has a condition, a fragment that is
 *   more than abilities, triggers and plain statics — refuses the whole reading, and the tail stays
 *   unread as before (D572). Half a leveler is the Brimstone Mage problem D572 fixed.
 */
function readLevelBands(lines: readonly string[], first: number, name: string): {
  readonly bands: readonly LevelBand[];
  readonly fragment: Record<string, unknown>;
  readonly claimed: readonly string[];
} | null {
  const header = lines.findIndex((line) => /^Level up ((?:\{[^}]+\})+)/.test(line.trim()));
  if (header < 0 || header > first) return null;
  const cost = /^Level up ((?:\{[^}]+\})+)/.exec(lines[header]!.trim())![1]!;
  const bands: LevelBand[] = [];
  const abilities: AbilityDef[] = [levelUpAbility(cost)];
  const triggers: TriggerDef[] = [];
  const statics: unknown[] = [];
  let index = first;
  while (index < lines.length) {
    const band = /^LEVEL (\d+)(?:-(\d+)|\+)$/.exec(lines[index]!.trim());
    if (band === null) return null;
    const size = /^(\d+)\/(\d+)$/.exec((lines[index + 1] ?? '').trim());
    if (size === null) return null;
    const from = Number(band[1]);
    const to = band[2] === undefined ? undefined : Number(band[2]);
    const inBand = (state: GameState, id: string): boolean => {
      const level = state.instances[id]?.counters['level'] ?? 0;
      return level >= from && (to === undefined || level <= to);
    };
    const keywords: string[] = [];
    index += 2;
    for (; index < lines.length && !/^LEVEL /.test(lines[index]!.trim()); index++) {
      const line = lines[index]!;
      const words = printedKeywords(line);
      const parts = line.replace(/\([^)]*\)/g, '').split(/,\s*/).map((part) => part.trim()).filter((part) => part !== '');
      if (words.length > 0 && words.length === parts.length) { keywords.push(...words); continue; }
      const read = lineScriptFor(line, name);
      if (read === null) return null;
      /*
        Only the three lists a band can scope. A line that hands an ability to something else
        (`grantedTriggers`, `grantedAbilities`) is refused here, not read: the grant would be indexed
        by a static that a band condition cannot carry, and it would not be this card's ability.
      */
      for (const key of Object.keys(read)) {
        if (!['abilities', 'triggers', 'statics'].includes(key)) return null;
      }
      for (const ability of read.abilities ?? []) {
        const prior = ability.activateOnlyIf;
        abilities.push({
          ...ability,
          activateOnlyIf: (state, source, controller) => inBand(state, source)
            && (prior === undefined || prior(state, source, controller)),
        });
      }
      for (const trigger of read.triggers ?? []) {
        const prior = trigger.condition;
        triggers.push({ ...trigger, condition: (c) => inBand(c.state, c.source) && (prior === undefined || prior(c)) });
      }
      for (const fixed of read.statics ?? []) {
        const effect = ((fixed as unknown as { effect?: Record<string, unknown> }).effect) ?? {};
        if (effect['while'] !== undefined || effect['grants'] !== undefined || effect['grantsAbilities'] !== undefined) return null;
        statics.push({
          ...fixed,
          effect: {
            ...effect,
            while: { kind: 'source-has-counter', counter: 'level', atLeast: from, ...(to === undefined ? {} : { below: to + 1 }) },
          },
        });
      }
    }
    bands.push({ from, power: Number(size[1]), toughness: Number(size[2]), ...(keywords.length === 0 ? {} : { keywords }) });
  }
  return {
    bands,
    fragment: {
      levelUp: { cost },
      abilities,
      ...(triggers.length === 0 ? {} : { triggers }),
      ...(statics.length === 0 ? {} : { statics }),
    },
    claimed: [lines[header]!, ...lines.slice(first)],
  };
}

/**
 * **A Spacecraft's station bands, read** (D637, CR 721): the same scoping as a leveler's (D636), on
 * charge counters, with three differences the rules make.
 *
 * - There is no size line under a header. A Spacecraft's printed power and toughness belong to its
 *   **last** band, where "It's an artifact creature at N+" — so that band is marked `creature`, and
 *   a Spacecraft printed with no size never becomes one.
 * - The bands are **cumulative**: each is "as long as it has N or more charge counters" with no
 *   upper edge, so at 8 counters the 2+ lines and the 8+ lines all apply. Scoped abilities ask only
 *   the lower edge, and a band's keywords include every lower band's, because `levelBandOf` picks
 *   one band.
 * - The ability that adds the counters is the "Station" line, built by `stationAbility`.
 */
function readStationBands(lines: readonly string[], first: number, name: string, size: { power: number; toughness: number } | null): {
  readonly bands: readonly LevelBand[];
  readonly fragment: Record<string, unknown>;
  readonly claimed: readonly string[];
} | null {
  const header = lines.findIndex((line) => /^Station(?:\s*\(.*\))?$/.test(line.trim()));
  if (header < 0 || header > first) return null;
  const bands: LevelBand[] = [];
  const abilities: AbilityDef[] = [stationAbility()];
  const triggers: TriggerDef[] = [];
  const statics: unknown[] = [];
  const keywords: string[] = [];
  let index = first;
  while (index < lines.length) {
    const band = /^STATION (\d+)\+$/.exec(lines[index]!.trim());
    if (band === null) return null;
    const from = Number(band[1]);
    const charged = (state: GameState, id: string): boolean => (state.instances[id]?.counters['charge'] ?? 0) >= from;
    index += 1;
    for (; index < lines.length && !/^STATION /.test(lines[index]!.trim()); index++) {
      const line = lines[index]!;
      const words = printedKeywords(line);
      const parts = line.replace(/\([^)]*\)/g, '').split(/,\s*/).map((part) => part.trim()).filter((part) => part !== '');
      if (words.length > 0 && words.length === parts.length) { keywords.push(...words); continue; }
      const read = lineScriptFor(line, name);
      if (read === null) return null;
      // As for a leveler: a grant (`grantedTriggers`, `grantedAbilities`) cannot be scoped, so it refuses.
      for (const key of Object.keys(read)) {
        if (!['abilities', 'triggers', 'statics'].includes(key)) return null;
      }
      for (const ability of read.abilities ?? []) {
        const prior = ability.activateOnlyIf;
        abilities.push({ ...ability, activateOnlyIf: (state, source, controller) => charged(state, source) && (prior === undefined || prior(state, source, controller)) });
      }
      for (const trigger of read.triggers ?? []) {
        const prior = trigger.condition;
        triggers.push({ ...trigger, condition: (c) => charged(c.state, c.source) && (prior === undefined || prior(c)) });
      }
      for (const fixed of read.statics ?? []) {
        const effect = ((fixed as unknown as { effect?: Record<string, unknown> }).effect) ?? {};
        if (effect['while'] !== undefined || effect['grants'] !== undefined || effect['grantsAbilities'] !== undefined) return null;
        statics.push({ ...fixed, effect: { ...effect, while: { kind: 'source-has-counter', counter: 'charge', atLeast: from } } });
      }
    }
    bands.push({
      from, counter: 'charge', power: size?.power ?? 0, toughness: size?.toughness ?? 0,
      ...(keywords.length === 0 ? {} : { keywords: [...new Set(keywords)] }),
    });
  }
  if (bands.length === 0) return null;
  if (size !== null) bands[bands.length - 1] = { ...bands[bands.length - 1]!, creature: true };
  return {
    bands,
    fragment: {
      abilities,
      ...(triggers.length === 0 ? {} : { triggers }),
      ...(statics.length === 0 ? {} : { statics }),
    },
    claimed: [lines[header]!, ...lines.slice(first)],
  };
}

/**
 * **A Class's levels, read** (D638, CR 716). From the first "{cost}: Level N" header to the end of the
 * card, each header is the ability that gains that level (`classLevelAbility`), and the lines under
 * it are abilities the Class has **from that level on** — cumulative, like station. Scoped as D636
 * scopes a band, on `CardInstance.classLevel`: activated abilities through `activateOnlyIf`,
 * triggers through `condition`, statics through a `source-class-level` `while`. Anything that cannot
 * be scoped refuses the reading, and the tail stays unread as D620 left it.
 */
function readClassLevels(lines: readonly string[], first: number, name: string): {
  readonly fragment: Record<string, unknown>;
  readonly claimed: readonly string[];
} | null {
  const abilities: AbilityDef[] = [];
  const triggers: TriggerDef[] = [];
  const statics: unknown[] = [];
  let index = first;
  while (index < lines.length) {
    const header = /^((?:\{[^}]+\})+): Level (\d+)$/i.exec(lines[index]!.trim());
    if (header === null) return null;
    const level = Number(header[2]);
    if (level < 2) return null;
    abilities.push(classLevelAbility(header[1]!, level));
    const reached = (state: GameState, id: string): boolean => {
      const inst = state.instances[id];
      return inst !== undefined && inst.zone === 'battlefield' && (inst.classLevel ?? 1) >= level;
    };
    index += 1;
    for (; index < lines.length && !/^(?:\{[^}]+\})+: Level \d+$/i.test(lines[index]!.trim()); index++) {
      const read = lineScriptFor(lines[index]!, name);
      if (read === null) return null;
      // A grant (`grantedTriggers`, `grantedAbilities`) cannot be scoped, so it refuses, as in a band.
      for (const key of Object.keys(read)) {
        if (!['abilities', 'triggers', 'statics'].includes(key)) return null;
      }
      for (const ability of read.abilities ?? []) {
        const prior = ability.activateOnlyIf;
        abilities.push({ ...ability, activateOnlyIf: (state, source, controller) => reached(state, source) && (prior === undefined || prior(state, source, controller)) });
      }
      for (const trigger of read.triggers ?? []) {
        const prior = trigger.condition;
        triggers.push({ ...trigger, condition: (c) => reached(c.state, c.source) && (prior === undefined || prior(c)) });
      }
      for (const fixed of read.statics ?? []) {
        const effect = ((fixed as unknown as { effect?: Record<string, unknown> }).effect) ?? {};
        if (effect['while'] !== undefined || effect['grants'] !== undefined || effect['grantsAbilities'] !== undefined) return null;
        statics.push({ ...fixed, effect: { ...effect, while: { kind: 'source-class-level', atLeast: level } } });
      }
    }
  }
  if (abilities.length === 0) return null;
  return {
    fragment: {
      abilities,
      ...(triggers.length === 0 ? {} : { triggers }),
      ...(statics.length === 0 ? {} : { statics }),
    },
    claimed: lines.slice(first),
  };
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
  // The count covers the power and the toughness unless the ability names one of them; the other
  // has to be printed as a number (D976 adds the toughness-only mirror).
  if (defines.applies === undefined || defines.applies === 'both') return null;
  const other = defines.applies === 'power' ? (row.toughness ?? '').trim() : (row.power ?? '').trim();
  return INTEGER.test(other)
    ? null
    : `${name}: its ${defines.applies} is a count but its ${defines.applies === 'power' ? 'toughness' : 'power'} of ${other || '(none)'} is not a number`;
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
  // A bare X is the one the mana cost pays, for a spell and for a permanent's triggers (D1055).
  const built = withXPayable(/\{X\}/i.test(row.mana_cost ?? ''), () => compileUncached(row));
  if (key !== null) {
    if (COMPILED.size >= COMPILED_CAP) COMPILED.clear();
    COMPILED.set(key, built);
  }
  return built;
}

/**
 * The layouts whose faces this module can build, in `CardFaces.kind`'s words (D591).
 *
 * The three the engine already plays: an **adventurer** (a creature with an instant or sorcery on
 * it, CR 715), a **modal double-faced** card (either face may be played, CR 712), and a
 * **transforming** one (cast as its front, turned over by an effect, CR 712). And since D978 a
 * **prepare** card, whose spell face is cast only as a copy while the creature is prepared. Split,
 * flip, meld and the rest are each their own rules and are still refused as more than one face.
 */
const FACE_LAYOUTS: Readonly<Record<string, CardFaces['kind']>> = {
  adventure: 'adventure', modal: 'modal', modal_dfc: 'modal', transform: 'transform',
  // A creature and the spell it casts copies of while prepared (D978). See `CardInstance.prepared`.
  prepare: 'prepare',
  // An adventurer whose spell is shuffled into the library as it resolves (D979).
  omen: 'omen',
  // A Kamigawa flip card (D982): the upright half is the card, the flipped half its other face.
  flip: 'flip',
};

/** `card_faces` as a list, from the array Scryfall writes or the JSON text the database holds. */
function faceRowsOf(row: CardDataRow): readonly CardFaceRow[] {
  const raw = row.card_faces;
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as CardFaceRow[] : [];
  } catch {
    return [];
  }
}

/**
 * A multi-face card: its front face compiled as the card, every other face compiled on its own, and
 * the faces put on the definition where the engine already looks for them (D591).
 *
 * **Why each face is compiled separately.** The engine asks for a face's script by the face's own
 * definition (`scriptForCard(faceDef)`), exactly as it does for the pool's hand-written Merfolk
 * Secretkeeper and Delver of Secrets, so the faces need nothing from this function but their
 * printed data. What this function adds is the **honest count**: a face's unread lines are the
 * card's unread lines, so an adventurer whose creature reads and whose adventure does not is not
 * reported as read whole. A face this module refuses outright is reported as one unread line
 * naming it; a face with no printed definition at all refuses the card, because the engine would
 * have nothing to turn over to.
 *
 * **Which numbers each face takes.** The front's are the card's in every zone but the stack and the
 * battlefield (CR 712.4, CR 715.4). A transforming card's back face has no cost and the front's
 * mana value (CR 712.4c). An adventure and a modal back face are cast for their own cost, so their
 * mana value is their own.
 */
function compileFaces(row: CardDataRow, kind: CardFaces['kind'], faces: readonly CardFaceRow[]): Compilation {
  const front = faces[0]!;
  const frontRow: CardDataRow = {
    ...row,
    name: front.name ?? row.name,
    type_line: front.type_line ?? row.type_line,
    oracle_text: front.oracle_text ?? row.oracle_text,
    mana_cost: front.mana_cost ?? row.mana_cost,
    colors: front.colors ?? row.colors,
    power: front.power ?? row.power ?? null,
    toughness: front.toughness ?? row.toughness ?? null,
    loyalty: front.loyalty ?? row.loyalty ?? null,
    layout: 'normal',
    card_faces: null,
  };
  const card = compileCard(frontRow);
  if (!card.ok) return card;
  const frontValue = card.def.cmc;
  const backs: CardDef[] = [];
  const unread = [...card.unread];
  /*
    And every face's read lines with its unread ones (D592). D591 kept the back faces' unread lines
    and dropped their read ones, so a back-face line that became readable left the count instead of
    moving across it — the line total fell as coverage rose.
  */
  const readLines = [...card.compiled];
  for (const face of faces.slice(1)) {
    const faceRow: CardDataRow = {
      name: face.name ?? null,
      type_line: face.type_line ?? null,
      oracle_text: face.oracle_text ?? null,
      // A flipped permanent keeps the card's one mana cost (CR 710.2a); a transformed one has none.
      mana_cost: kind === 'flip' ? front.mana_cost ?? row.mana_cost ?? '' : face.mana_cost ?? '',
      cmc: kind === 'transform' || kind === 'flip' ? frontValue : costValue(parseManaCost(face.mana_cost ?? '')),
      colors: face.colors ?? [],
      power: face.power ?? null,
      toughness: face.toughness ?? null,
      loyalty: face.loyalty ?? null,
      layout: 'normal',
    };
    const compiled = compileCard(faceRow);
    if (compiled.ok) {
      backs.push(compiled.def);
      unread.push(...compiled.unread);
      readLines.push(...compiled.compiled);
      continue;
    }
    const printed = printedDef(faceRow);
    if ('why' in printed) return { ok: false, why: `${card.def.name}: its face ${face.name ?? '(unnamed)'} — ${printed.why}` };
    backs.push(printed.def);
    unread.push({ line: `(${printed.def.name}) ${compiled.why}`, why: 'no-reader' });
  }
  return {
    ...card,
    def: { ...card.def, faces: { kind, cards: backs } },
    compiled: readLines,
    unread,
  };
}

/**
 * A split card (D1294, CR 708): two spells on one card, each cast as itself and never the card as a
 * whole. Fire // Ice, Commit // Memory, Expansion // Explosion.
 *
 * Each half is compiled on its own, as a single card, and the whole is the hand-written split shape
 * the engine already plays (`FIRE_ICE`): both names, both types and both costs joined with " // ",
 * the halves' colours together, and their mana values added, which is the card's mana value
 * everywhere but the stack (CR 708.4). The whole has no script of its own: a split card is only
 * ever cast as one of its halves (`castableAsPrinted`).
 *
 * Two kinds of split card are refused rather than played wrongly:
 * - **Aftermath** (CR 702.127): its second half may be cast only from the graveyard. Offered from
 *   the hand like any other half, it would be a spell the card does not allow.
 * - **Rooms** (CR 709.5): an enchantment with two doors, one unlocked as it is cast and the other
 *   unlocked later. The engine has no doors yet.
 *
 * Fuse (CR 702.102), casting both halves together from the hand, is a keyword line each half prints.
 * It stays unread: each half is still cast on its own, as the card allows.
 */
function compileSplit(row: CardDataRow, faces: readonly CardFaceRow[]): Compilation {
  const named = faces.map((face) => (face.name ?? '').trim()).join(' // ');
  if (faces.some((face) => /^aftermath\b/im.test(face.oracle_text ?? ''))) {
    return { ok: false, why: `${named}: aftermath is not played yet` };
  }
  if (faces.some((face) => /\bRoom\b/.test(face.type_line ?? ''))) {
    return { ok: false, why: `${named}: a Room's doors are not played yet` };
  }
  const halves: CardDef[] = [];
  const compiled: string[] = [];
  const unread: UnreadLine[] = [];
  let scripted = false;
  for (const face of faces) {
    const half = compileCard({
      name: face.name ?? null,
      type_line: face.type_line ?? null,
      oracle_text: face.oracle_text ?? null,
      mana_cost: face.mana_cost ?? '',
      cmc: costValue(parseManaCost(face.mana_cost ?? '')),
      colors: face.colors ?? [],
      power: face.power ?? null,
      toughness: face.toughness ?? null,
      loyalty: face.loyalty ?? null,
      layout: 'normal',
    });
    if (!half.ok) return { ok: false, why: `${named}: its half ${face.name ?? '(unnamed)'} — ${half.why}` };
    halves.push(half.def);
    compiled.push(...half.compiled);
    unread.push(...half.unread);
    if (half.script !== undefined) scripted = true;
  }
  const colours = new Set(halves.flatMap((half) => half.colors));
  return {
    ok: true,
    def: {
      name: named,
      typeLine: halves.map((half) => half.typeLine).join(' // '),
      manaCost: halves.map((half) => half.manaCost).join(' // '),
      cmc: halves.reduce((sum, half) => sum + half.cmc, 0),
      oracleText: halves.map((half) => half.oracleText).join('\n'),
      colors: ['W', 'U', 'B', 'R', 'G'].filter((c) => colours.has(c)),
      faces: { kind: 'split', cards: halves },
    },
    compiled,
    unread,
    source: scripted ? 'lines' : 'printed-only',
  };
}

/** The compilation itself. Called only by `compileCard`, which caches it. */
function compileUncached(row: CardDataRow): Compilation {
  const layout = (row.layout ?? 'normal').trim().toLowerCase();
  if (layout === 'split') {
    const halves = faceRowsOf(row);
    if (halves.length >= 2) return compileSplit(row, halves);
  }
  const faceKind = FACE_LAYOUTS[layout];
  const faces = faceKind === undefined ? [] : faceRowsOf(row);
  if (faceKind !== undefined && faces.length >= 2) return compileFaces(row, faceKind, faces);
  return compileSingle(row);
}

/** The verbs a card names itself with in the plural (D1107), and their singular. */
const PLURAL_SELF_VERBS: Readonly<Record<string, string>> = {
  enter: 'enters', attack: 'attacks', die: 'dies', deal: 'deals', block: 'blocks', get: 'gets',
  have: 'has', gain: 'gains', become: 'becomes', leave: 'leaves', are: 'is', "aren't": "isn't",
};

/**
 * A card that is two characters, or a crowd (D1107): "When Cloak and Dagger enter", "Whenever
 * Bebop & Rocksteady attack or block", "When The Duras Sisters die". Every reader spells the self
 * reference with a singular verb, so the plural is put in the singular before the lines are read:
 * the rules are the same for one permanent whatever its name says it is (CR 201.5). Only for a name
 * that is plural ("and", "&", or "The …s"), and only the verb straight after the name.
 */
function singularSelf(line: string, name: string): string {
  const short = name.includes(', ') ? name.slice(0, name.indexOf(', ')) : name;
  if (!/\s(?:and|&)\s/.test(short) && !/^The .+s$/.test(short)) return line;
  const names = [...new Set([name, short])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const verbs = Object.keys(PLURAL_SELF_VERBS).join('|');
  const verb = (word: string): string => PLURAL_SELF_VERBS[word.toLowerCase()] ?? word;
  return line.replace(new RegExp(`\\b(${names}) (${verbs})\\b(?:( or | and/or | and )(${verbs})\\b)?`, 'g'),
    (_all, who: string, first: string, joiner?: string, second?: string) =>
      `${who} ${verb(first)}${joiner === undefined ? '' : `${joiner}${verb(second!)}`}`);
}

/**
 * Whether battles are permanents this engine plays (CR 310). False while battle cards are refused
 * (D591): their defense comes from card data the production import does not have yet.
 */
const BATTLES_PLAYED = false;

/**
 * A battle named where a player or a permanent may be (D1111): "to a player or battle", "target
 * opponent, battle, or planeswalker", "target creature, planeswalker, or battle". While battles are
 * refused (`BATTLES_PLAYED`), no battle can be on the battlefield, so the word names nothing that
 * can exist, and taking it out of the list changes no game. It stays in the text the card shows;
 * this is only what the readers are given. When battles are played, this goes, and the readers
 * have to learn the word instead.
 */
function withoutBattles(line: string): string {
  // Not a battle **card** ("an instant, sorcery, or battle card"): a battle card is a card like
  // any other in a hand, a library or a graveyard, refused or not.
  if (BATTLES_PLAYED || !/\bbattles?\b(?! cards?\b)/i.test(line)) return line;
  return line
    // "A, B, or battle" and "A, battle, or B": the list one shorter.
    .replace(/((?:[\w'-]+ )*[\w'-]+), ((?:[\w'-]+ )*[\w'-]+), (or|and\/or) battles?\b(?! cards?\b)/gi, '$1 $3 $2')
    .replace(/((?:[\w'-]+ )*[\w'-]+), battles?, (or|and\/or) (?!(?:[\w'-]+ )*cards?\b)/gi, '$1 $2 ')
    // "A or battle", "A and/or battle".
    .replace(/ (?:or|and\/or) battles?\b(?! cards?\b)/gi, '');
}

/** One face, or a card with only one. */
function compileSingle(row: CardDataRow): Compilation {
  const printed = printedDef(row);
  if ('why' in printed) return { ok: false, why: printed.why };
  let def = printed.def;
  const typeLine = parseTypeLine(def.typeLine);
  // A plural self reference in the singular (D1107): see `singularSelf`.
  // And a battle where nothing can be one (D1111): see `withoutBattles`.
  const lines = printedRulesLines(row.oracle_text).map((line) => withoutBattles(singularSelf(line, def.name)));

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
    A **battle** is refused for the same reason, and more firmly (D591): its defense counters, the
    opponent who protects it, attacking it and defeating it are rules (CR 310), not text, and this
    engine has none of them. Compiled, an Invasion would arrive, do its enter trigger and then sit
    there for ever — nobody could attack it, so it could never be defeated and turn over. Its text
    reads perfectly well, which is exactly why it has to be refused here rather than left to an
    unread line: there would be no unread line to flag it.
  */
  if (hasType(typeLine, 'battle')) {
    return { ok: false, why: `${def.name}: a battle's defense and protector are rules this engine does not have yet` };
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
    /*
      A die-roll table (D1154): the roll line and its rows become one line for the spell reader, and
      that line's fate is reported as the printed lines' — all compiled, or all unread.
    */
    const table = dieTableFor(lines);
    const spellLines = table === null ? lines
      : lines.filter((line) => !table.claimed.includes(line) || line === table.roll).map((line) => (line === table.roll ? table.synthetic : line));
    const read = spellScriptFor(spellLines, def.name);
    const back = (list: readonly string[]): string[] => list.flatMap((line) => (table !== null && line === table.synthetic ? [...table.claimed] : [line]));
    const spell = table === null ? read : { ...read, compiled: back(read.compiled), unread: back(read.unread) };
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
  const enterChoice = enterChoiceOf(lines);
  if (attachment !== null) {
    merge(built, attachment.fragment);
    compiled.push(...attachment.claimed);
  }

  /*
    A leveler's bands are not the card's abilities (CR 711.2, D572).

    From the first `LEVEL n-m` header to the end of the card, every line is something the creature
    has while it holds that many level counters. Read line by line they would each become an
    ability of the card itself — which is what happened until D572, and it is the worst kind of
    reading: Brimstone Mage compiled to a creature that taps for one damage and also for three,
    from the turn it arrives. So the whole tail is reported unread, header and size lines included,
    and nothing under it is offered to a reader. `levelBands` on the definition is the engine's
    reading of a band; nothing fills it from printed text yet, and an unread line is what says so.
  */
  /*
    And a **Class**'s levels (D620), which are the same problem in a different shape: every
    line after "{1}{R}: Level 2" is an ability the Class has only from that level on. Read line by
    line, Barbarian Class gave its creatures haste — its level-3 line — from the turn it was cast,
    once D620 could read that line at all. Nothing reads class levels yet, so from the first level
    header to the end of the card every line is reported, and the level-1 lines above it read as
    the card's own. The header itself is an activated ability with no effect this engine has.
  */
  const classLevel = hasType(typeLine, 'enchantment') && /\bClass\b/.test(def.typeLine ?? '')
    ? lines.findIndex((line) => /^(?:\{[^}]+\})+: Level \d+$/i.test(line.trim()))
    : -1;
  const leveled = lines.findIndex((line) => LEVEL_BAND_HEADER.test(line));
  let firstBand = leveled >= 0 && classLevel >= 0 ? Math.min(leveled, classLevel) : Math.max(leveled, classLevel);
  // A leveler whose every band reads (D636): the bands go on the definition, the rest into the script.
  const levelled = leveled >= 0 && classLevel < 0 && hasType(typeLine, 'creature')
    ? readLevelBands(lines, leveled, def.name)
    : null;
  // And a Spacecraft (D637): station bands, with its printed size on the last.
  const sized = /^\d+$/.test(def.power ?? '') && /^\d+$/.test(def.toughness ?? '')
    ? { power: Number(def.power), toughness: Number(def.toughness) }
    : null;
  const stationed = levelled === null && leveled >= 0 && classLevel < 0 && /\bSpacecraft\b/.test(def.typeLine ?? '')
    ? readStationBands(lines, leveled, def.name, sized)
    : null;
  if (stationed !== null && merge(built, stationed.fragment as Partial<CardScript>) === 'merged') {
    def = { ...def, levelBands: stationed.bands };
    for (const line of stationed.claimed) claimed.add(line);
    compiled.push(...stationed.claimed);
    firstBand = -1;
  }
  // And a Class (D638): its levels, from the first "{cost}: Level N" down.
  const classed = classLevel >= 0 && (leveled < 0 || classLevel < leveled) ? readClassLevels(lines, classLevel, def.name) : null;
  if (classed !== null && merge(built, classed.fragment as Partial<CardScript>) === 'merged') {
    for (const line of classed.claimed) claimed.add(line);
    compiled.push(...classed.claimed);
    firstBand = -1;
  }
  if (levelled !== null && merge(built, levelled.fragment as Partial<CardScript>) === 'merged') {
    def = { ...def, levelBands: levelled.bands };
    for (const line of levelled.claimed) claimed.add(line);
    compiled.push(...levelled.claimed);
    firstBand = -1;
  }

  // A die-roll table (D1154), read as one line before the lines are offered one by one: see `dieTableFor`.
  const dieTable = firstBand >= 0 ? null : dieTableFor(lines.filter((line) => !claimed.has(line)));
  const dieRead = dieTable === null ? null : lineScriptFor(dieTable.synthetic, def.name);
  if (dieTable !== null && dieRead !== null && merge(built, dieRead) === 'merged') {
    for (const line of dieTable.claimed) claimed.add(line);
    compiled.push(...dieTable.claimed);
  }

  // A modal trigger and its bullets (D757), read as one group before the lines are offered one by one.
  const modalTrigger = firstBand >= 0 ? null : modalTriggerFor(lines.filter((line) => !claimed.has(line)), def.name);
  if (modalTrigger !== null && merge(built, modalTrigger.fragment) === 'merged') {
    for (const line of modalTrigger.claimed) claimed.add(line);
    compiled.push(...modalTrigger.claimed);
  }

  // A modal activated ability (D843): one ability per mode, each with the whole cost.
  const modalAbility = firstBand >= 0 ? null : modalAbilityFor(lines.filter((line) => !claimed.has(line)), def.name);
  if (modalAbility !== null && merge(built, modalAbility.fragment) === 'merged') {
    for (const line of modalAbility.claimed) claimed.add(line);
    compiled.push(...modalAbility.claimed);
  }

  for (const [index, line] of lines.entries()) {
    if (claimed.has(line)) continue;
    if (firstBand >= 0 && index >= firstBand) { unread.push({ line, why: 'no-reader' }); continue; }
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
    /*
      Ward in a keyword list (D659): "Flying, ward {2}", "Trample, haste, ward {1}". The printed
      keywords are read off the oracle text (`printedParts` skips the ward part); the ward is a
      trigger, emitted here from the part on its own. Asked before the printed-line check, which
      would otherwise count the line compiled and emit no ward at all.
    */
    /*
      Deck-construction keywords (D670): "Partner", "Partner—Survivors" (and "Partner—Friends
      forever"), "Choose a Background", "Doctor's companion". Each says which second commander a deck may have and does
      nothing once the game starts, and `customDeck`'s `partnersLegally` (D640) is where it is
      enforced — so the line is compiled and emits nothing, like a printed keyword. "Partner with
      <name>" is **not** one of them: its reminder text is a real enter trigger (CR 702.124j), read
      just below (D1091).
    */
    if (/^(?:partner|partner\s*[—-]\s*[a-z' ]+|choose a background|doctor['’]s companion)$/i
      .test(line.replace(/\([^)]*\)/g, '').trim())) {
      compiled.push(line);
      continue;
    }
    /*
      "Partner with <name>" (D1091, CR 702.124j): the deck half is `partnersLegally`'s, and the game
      half is the reminder text's enter trigger — "When this creature enters, target player may
      search their library for a card named <name>, reveal it, put it into their hand, then
      shuffle." Read by giving that sentence to the line reader, which reads every word of it
      already (D986's search by name), so the keyword and its printed reminder cannot disagree.
    */
    /*
      Graft N (D1093, CR 702.58a): "This creature enters with N +1/+1 counters on it" and "Whenever
      another creature enters, you may move a +1/+1 counter from this creature onto it." Read as
      those two sentences, the way "Partner with" is just below.
    */
    const graft = /^graft (\d+)$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (graft !== null) {
      const enters = lineScriptFor(`${def.name} enters with ${graft[1]} +1/+1 counters on it.`, def.name);
      const moves = lineScriptFor(`Whenever another creature enters, you may move a +1/+1 counter from ${def.name} onto it.`, def.name);
      if (enters !== null && moves !== null && moves.triggers?.length === 1 && Object.keys(moves).length === 1) {
        const fragment: Partial<CardScript> = { ...enters, triggers: [{ ...moves.triggers[0]!, description: `Graft ${graft[1]}` }] };
        if (merge(built, fragment) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
        compiled.push(line);
        continue;
      }
    }
    /*
      Champion an X (D1094): "Champion a creature", "Champion a Goblin", "Champion a Treefolk or
      Warrior". See `championTriggers`. A word that is not "creature" or a creature type stays unread.
    */
    const champion = /^champion an? (.+?)$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (champion !== null) {
      const kinds = champion[1]!.split(/\s+or\s+/).map((k) => k.trim());
      if (kinds.every((k) => k.toLowerCase() === 'creature' || isCreatureType(k))) {
        if (merge(built, { triggers: [...championTriggers(kinds, champion[1]!)] }) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
        compiled.push(line);
        continue;
      }
    }
    const partnerWith = /^partner with (.+?)\.?$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (partnerWith !== null) {
      const named = partnerWith[1]!;
      const read = lineScriptFor(
        `When ${def.name} enters, target player may search their library for a card named ${named}, reveal it, put it into their hand, then shuffle.`,
        def.name,
      );
      if (read !== null && read.triggers?.length === 1 && Object.keys(read).length === 1) {
        const fragment: Partial<CardScript> = { triggers: [{ ...read.triggers[0]!, description: `Partner with ${named}` }] };
        if (merge(built, fragment) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
        compiled.push(line);
        continue;
      }
    }
    /*
      "~ can be your commander." (D761): the planeswalkers and other cards that may lead a deck
      (CR 903.3d). A deck-construction statement with no effect once the game starts, and nothing
      here restricts which card a deck names as its commander, so the line is compiled and emits
      nothing. The subject is the card's name or its short name ("Svega can be your commander").
    */
    const leader = /^(.+?) can be your commander\.?$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (leader !== null && (def.name === leader[1] || def.name.startsWith(`${leader[1]!},`) || def.name.startsWith(`${leader[1]!} `))) {
      compiled.push(line);
      continue;
    }
    /*
      **Backup N** (D671, CR 702.165): "When this creature enters, put N +1/+1 counters on target
      creature. If that's another creature, it gains the following abilities until end of turn."
      Read when every line after it is a printed keyword line (Deathtouch, Lifelink, "Flying, first
      strike") — the abilities a keyword grant can carry. The counters are the ordinary enter
      trigger, read by the line reader from its own sentence; the grant is added to its effect, and
      only for a target that is not the creature itself. A following line that is a triggered or
      activated ability leaves Backup unread: handing those to another creature is a grant of a
      different kind.
    */
    const backup = /^backup (\d+)$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (backup !== null) {
      const following = lines.slice(index + 1);
      /*
        What "the following abilities" are (D927): each line below Backup is keywords, one triggered
        ability, or one activated ability. Keywords ride the pump; a trigger or an ability is put on
        the card's `grantedTriggers` / `grantedAbilities` and handed over by index (`grants`,
        `grantsAbilities`), the mechanism soulbond's grants use, so the creature backed up has them
        until end of turn. Any other line refuses Backup. The card's own copies of those lines are
        still read below as its own abilities, which is what "this creature" has printed.
      */
      // `printedKeywords` reads a line only when every part of it is a keyword, so a list with one
      // unknown word ("Flying, banding") comes back empty and refuses Backup.
      const keywordsOf: string[] = [];
      const grantedTriggers: TriggerDef[] = [];
      const grantedAbilities: NonNullable<CardScript['grantedAbilities']>[number][] = [];
      let readable = following.length > 0;
      for (const rest of following) {
        const words = printedKeywords(rest);
        if (words.length > 0) { keywordsOf.push(...words); continue; }
        const read = lineScriptFor(rest, def.name);
        const keys = read === null ? [] : Object.keys(read);
        if (read?.triggers?.length === 1 && keys.length === 1) { grantedTriggers.push(read.triggers[0]!); continue; }
        if (read?.abilities?.length === 1 && keys.length === 1) { grantedAbilities.push(read.abilities[0]!); continue; }
        readable = false;
        break;
      }
      const n = Number(backup[1]);
      const enters = n >= 1 && readable
        ? lineScriptFor(`When this creature enters, put ${n === 1 ? 'a +1/+1 counter' : `${['', '', 'two', 'three', 'four', 'five'][n] ?? n} +1/+1 counters`} on target creature.`, def.name)
        : null;
      const trigger = enters?.triggers?.length === 1 && Object.keys(enters).length === 1 ? enters.triggers[0]! : null;
      if (trigger !== null) {
        const keywords = keywordsOf as NonNullable<Parameters<typeof pump>[4]['keywords']>;
        const grants = grantedTriggers.map((_t, i) => i);
        const grantsAbilities = grantedAbilities.map((_a, i) => i);
        const backed: TriggerDef = {
          ...trigger,
          description: line.replace(/\([^)]*\)/g, '').trim(),
          effect: (c) => {
            const after = trigger.effect(c);
            const target = c.targets[0];
            return target === undefined || target.kind !== 'card' || target.id === c.source
              || after.instances[target.id]?.zone !== 'battlefield'
              ? after
              : pump(after, [target.id], c.source, c.controller, {
                ...(keywords.length > 0 ? { keywords } : {}),
                ...(grants.length > 0 ? { grants } : {}),
                ...(grantsAbilities.length > 0 ? { grantsAbilities } : {}),
              });
          },
        };
        const fragment: Partial<CardScript> = {
          triggers: [backed],
          ...(grantedTriggers.length > 0 ? { grantedTriggers } : {}),
          ...(grantedAbilities.length > 0 ? { grantedAbilities } : {}),
        };
        if (merge(built, fragment) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
        compiled.push(line);
        continue;
      }
    }
    /*
      **Embalm and eternalize** (D673): the hand-written helpers Sacred Cat and Angel of Sanctions
      use, given the token's type line — the card's own, with Zombie put in front of its subtypes
      (CR 702.128a, 702.129a) — which is the one thing a line reader could not know. "Eternalize—
      {cost}, Discard a card" is the second printed shape (D579).
    */
    const zombie = /^(embalm|eternalize)\s*(?:[—-]\s*)?((?:\{[^}]*\})+)(,\s*discard a card)?\.?$/i
      .exec(line.replace(/\([^)]*\)/g, '').trim());
    if (zombie !== null && (zombie[3] === undefined || zombie[1]!.toLowerCase() === 'eternalize')) {
      const typed = parseTypeLine(def.typeLine);
      const tokenLine = `Token ${[...typed.supertypes, ...typed.types].join(' ')} \u2014 ${
        ['Zombie', ...typed.subtypes.filter((s) => s !== 'Zombie')].join(' ')}`;
      const ability = zombie[1]!.toLowerCase() === 'embalm'
        ? embalm(zombie[2]!, tokenLine)
        : eternalize(zombie[2]!, tokenLine, zombie[3] !== undefined);
      if (merge(built, { abilities: [ability] }) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
      compiled.push(line);
      continue;
    }
    /*
      **Offspring {N}** (D674, CR 702.175): "You may pay an additional {N} as you cast this spell.
      If you do, when this creature enters, create a 1/1 token copy of it." Kicker's machinery, which
      is what it is: the optional extra cost is `kicker` (the cast records `KICKED` on the permanent
      as it arrives), and the payoff is the card's own enter trigger, conditioned on that record,
      making a token copy whose printed size is 1/1 (`copyAsToken`'s profile, as eternalize's 4/4).
      The enter trigger's event shape is taken from the line reader rather than written here.
    */
    /*
      **Ravenous** (D985, CR 702.156a): "This creature enters with X +1/+1 counters on it. If X is
      5 or more, draw a card when it enters." Read as those two sentences, each by the reader that
      already has it; both or neither.
    */
    if (/^ravenous$/i.test(line.replace(/\([^)]*\)/g, '').trim())) {
      const parts = [
        lineScriptFor('This creature enters with X +1/+1 counters on it.', def.name),
        lineScriptFor('When this creature enters, if X is 5 or more, draw a card.', def.name),
      ];
      if (parts.every((part) => part !== null)) {
        const fragment: Record<string, unknown> = {};
        const fits = parts.every((part) => merge(fragment, part!) === 'merged');
        if (fits && merge(built, fragment as Partial<CardScript>) === 'merged') { compiled.push(line); continue; }
        unread.push({ line, why: 'field-conflict' });
        continue;
      }
    }
    const offspring = /^offspring\s+((?:\{[^}]*\})+)$/i.exec(line.replace(/\([^)]*\)/g, '').trim());
    if (offspring !== null) {
      const enters = lineScriptFor('When this creature enters, draw a card.', def.name)?.triggers?.[0];
      if (enters !== undefined) {
        const cost = offspring[1]!;
        const fragment: Partial<CardScript> = {
          kicker: { cost, description: `Offspring ${cost}` },
          triggers: [{
            ...enters,
            description: 'when this creature enters, if its offspring cost was paid, create a 1/1 token copy of it',
            condition: (c) => (c.state.instances[c.source]?.counters[KICKED] ?? 0) > 0,
            effect: (c) => (c.state.instances[c.source]?.zone === 'battlefield'
              ? copyAsToken(c.state, c.controller, c.source, 1, { as: 'offspring', power: '1', toughness: '1' })
              : c.state),
          }],
        };
        if (merge(built, fragment) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
        compiled.push(line);
        continue;
      }
    }
    const wardList = wardInList(line, def.name);
    if (wardList !== null) {
      if (merge(built, wardList) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
      compiled.push(line);
      continue;
    }
    if (isPrintedAbilityLine(line, def.name)) { compiled.push(line); continue; }

    /*
      A mana ability, asked **before** the general line reader and not after.

      `cardFromData` only answers when it can read the whole card, so a pain land with a second
      ability lands here — and until D497 this loop had no mana reader, so `lineScriptFor` claimed
      the line, built an ability out of its damage clause and dropped the `Add {U}` entirely.
      Cephalid Coliseum and ten other legal lands compiled to a land that taps for nothing, which
      is worse than an unread line: the bot plays it and then cannot use it.

      Order is the whole fix. Asked after, the general reader wins and the mana is lost again.
    */
    /*
      Path of Ancestry (D729): a mana line, then "When that mana is spent to cast a creature spell
      that shares a creature type with your commander, scry 1." The mana reads as the line before
      the rider, and the rider is a trigger the cast puts on the stack (`TriggerDef.whenManaSpent`).
    */
    const spentRider = /^(.+?\.)\s+When that mana is spent to cast a creature spell that shares a creature type with your commander, scry (\d+)\.?$/i.exec(line.trim());
    if (spentRider !== null) {
      const manaPart = manaAbilitiesFromLine(spentRider[1]!, def.name);
      const rider = manaSpentScryTrigger(Number(spentRider[2]!), def.name);
      if (manaPart !== null && rider !== null) {
        if (merge(built, { abilities: [...manaPart], triggers: [rider] }) === 'conflict') {
          unread.push({ line, why: 'field-conflict' });
          continue;
        }
        compiled.push(line);
        continue;
      }
    }
    const mana = manaAbilitiesFromLine(line, def.name);
    // Mana "of the chosen color" on a card that never chose a colour would tap for nothing (D642).
    if (mana !== null && ((/\bthe chosen colou?r\b/i.test(line) && enterChoice?.kind !== 'color')
      || (/\bthe chosen type\b/i.test(line) && enterChoice?.kind !== 'creature-type'))) {
      unread.push({ line, why: 'no-reader' });
      continue;
    }
    if (mana !== null) {
      if (merge(built, { abilities: [...mana] }) === 'conflict') {
        unread.push({ line, why: 'field-conflict' });
        continue;
      }
      compiled.push(line);
      continue;
    }
    /*
      A line that promises mana and could not be read is **unread**, full stop. It does not go on to
      the general reader, which would build an ability out of whatever follows the `Add` and leave
      the card producing nothing — the Coliseum failure, generalised. See `isManaAbilityLine`.
    */
    /*
      With one exception (D666): a tap ability that also sacrifices **another** permanent —
      Phyrexian Tower's "{T}, Sacrifice a creature: Add {B}{B}." The mana-line parser refuses the
      sacrifice (which creature is a choice it does not model), and the general reader models it:
      it is how "Sacrifice a creature: Add {C}{C}" has always read. Taken only when every ability
      that comes back makes mana and nothing else came back, so the Coliseum failure cannot recur.
    */
    if (isManaAbilityLine(line)) {
      // And the Urza lands' "If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C}
      // instead" (D867), which the general reader makes as a counted mana ability (`producesTimes`).
      const urza = /^\{T\}: Add \{[WUBRGC]\}\. If you control an? [^,]+ and an? [^,]+, add (?:\{[WUBRGC]\})+ instead\.?$/i.test(line.trim());
      const sacrificing = urza || /^\{T\},\s*Sacrifice (?:an?|another) [^:,]+:/i.test(line.trim())
        ? lineScriptFor(line, def.name) : null;
      const makesMana = sacrificing !== null && Object.keys(sacrificing).every((key) => key === 'abilities')
        && (sacrificing.abilities ?? []).length > 0
        && (sacrificing.abilities ?? []).every((ability) => (ability.produces ?? []).length > 0
          && (ability.cost.sacrifice !== undefined || (urza && ability.producesTimes !== undefined)));
      if (!makesMana) { unread.push({ line, why: 'no-reader' }); continue; }
      if (merge(built, sacrificing!) === 'conflict') { unread.push({ line, why: 'field-conflict' }); continue; }
      compiled.push(line);
      continue;
    }

    const fragment = lineScriptFor(line, def.name);
    if (fragment === null) { unread.push({ line, why: reasonFor(line) }); continue; }
    /*
      "The chosen type" on a card that never chose one (D641) — Chromatic Armor chooses with an
      activated ability, a Changeling lord chooses nothing — would install an anthem for no type and
      look read. Refused, so the line stays visible as unread.
    */
    const reads = choiceReadBy(fragment);
    if (reads !== null && reads !== enterChoice?.kind) { unread.push({ line, why: 'no-reader' }); continue; }
    if (merge(built, fragment) === 'conflict') {
      unread.push({ line, why: 'field-conflict' });
      continue;
    }
    compiled.push(line);
  }

  /*
    The bot's answer to "choose a creature type / a color", aimed now that every line is read (D641).
  */
  /*
    A name chosen to stop spells (D1238): the bot names what an opponent has cast rather than a
    permanent with an ability, which is the Pithing Needle default.
  */
  if (built['entersChoice'] === 'card-name' && ((built['castLimits'] ?? []) as readonly string[]).includes('chosen-name')) {
    const nonland = JSON.stringify(row.oracle_text ?? '').toLowerCase().includes('choose a nonland card name');
    built['decisions'] = [cardNameDecision(nonland, 'spells')];
  }
  if (built['entersChoice'] === 'creature-type' || built['entersChoice'] === 'color') {
    built['decisions'] = [enterChoiceDecision(
      built['entersChoice'], choiceAimOf(built['statics'] as CardScript['statics'], built['triggers'] as CardScript['triggers']),
      enterChoice?.except,
    )];
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

  /*
    A land's basic land types tap for mana with nothing printed (CR 305.6), so nothing in the loop
    above reads that mana — `cardFromData` does, and only for a card it reads whole (D587). Added
    first, as `cardFromData` orders them, and only for a colour no free `{T}: Add` above already
    makes, so a land that prints its type's ability as well does not tap for it twice.
  */
  if (hasType(typeLine, 'land')) {
    const existing = (built['abilities'] ?? []) as readonly { cost?: { tap?: boolean }; produces?: readonly string[] }[];
    const free = new Set(existing
      .filter((a) => a.produces !== undefined && a.produces.length === 1 && JSON.stringify(a.cost) === '{"tap":true}')
      .map((a) => a.produces![0]));
    const intrinsic = intrinsicManaAbilities(typeLine.subtypes).filter((a) => !free.has(a.produces![0]!));
    if (intrinsic.length > 0) built['abilities'] = [...intrinsic, ...existing];
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
