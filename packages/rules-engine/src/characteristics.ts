/**
 * What a permanent currently is, as opposed to what it was printed as.
 *
 * Power, toughness and keywords are **computed on demand** rather than stored on the instance. That
 * is not a style preference: a creature's power is its printed value plus its counters plus every
 * continuous effect currently applying to it, and effects expire. Writing a total into the instance
 * means the moment a "+3/+3 until end of turn" wears off there is nothing left that knows what to
 * subtract, and a stored number drifts from the truth every time two effects overlap.
 *
 * This is a deliberately simplified layer system. Real Magic applies continuous effects in seven
 * layers with timestamps and dependency ordering (CR 613). What is here covers the cases the card
 * pool actually produces — counters, until-end-of-turn pumps, static anthems, granted keywords —
 * applied in a fixed order with counters last, which gives the right answer for all of them. A card
 * needing true layer interaction (characteristic-setting effects, copy effects, layer 7b vs 7c
 * ordering) is not scriptable yet, and `scripts/` says so rather than producing a plausible wrong
 * number.
 */
import type { CardDef, CardInstance } from './cards.js';
import type { Color } from './mana.js';
import type { GameState, SeatIndex } from './types.js';

export const KEYWORDS = [
  'flying', 'reach', 'vigilance', 'haste', 'trample', 'first strike', 'double strike',
  'deathtouch', 'lifelink', 'hexproof', 'shroud', 'indestructible', 'menace', 'defender',
  'prowess', 'flash',
] as const;
export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET = new Set<string>(KEYWORDS);
export const isKeyword = (value: string): value is Keyword => KEYWORD_SET.has(value.toLowerCase());

export interface TypeLine {
  readonly supertypes: readonly string[];
  readonly types: readonly string[];
  readonly subtypes: readonly string[];
}

const EM_DASH = /\s[—-]\s/;

/** Splits `Legendary Creature — Goblin Warrior` into its three parts. */
export function parseTypeLine(line: string | null | undefined): TypeLine {
  const text = (line ?? '').trim();
  if (!text) return { supertypes: [], types: [], subtypes: [] };
  const [front, back] = text.split(EM_DASH);
  const words = (front ?? '').split(/\s+/).filter(Boolean);
  const SUPER = new Set(['legendary', 'basic', 'snow', 'world', 'ongoing', 'token']);
  const supertypes: string[] = [];
  const types: string[] = [];
  for (const word of words) {
    if (SUPER.has(word.toLowerCase())) supertypes.push(word);
    else types.push(word);
  }
  return {
    supertypes,
    types,
    subtypes: (back ?? '').split(/\s+/).filter(Boolean),
  };
}

export const hasType = (line: TypeLine, type: string): boolean =>
  line.types.some((t) => t.toLowerCase() === type.toLowerCase());
export const hasSubtype = (line: TypeLine, sub: string): boolean =>
  line.subtypes.some((t) => t.toLowerCase() === sub.toLowerCase());
export const isLegendary = (line: TypeLine): boolean =>
  line.supertypes.some((t) => t.toLowerCase() === 'legendary');

/**
 * Keywords printed on a card, read from its oracle text.
 *
 * Scripts declare their keywords explicitly, and that is the authority. This exists so an
 * **unscripted** card still behaves: a creature whose text begins "Flying, vigilance" should fly
 * and should not tap to attack even though nobody has written a script for it. Only matched at the
 * start of a line and as a whole word, so "Flying" counts and "creatures with flying can't block"
 * does not.
 */
export function printedKeywords(oracleText: string | null | undefined): Keyword[] {
  const found = new Set<Keyword>();
  for (const rawLine of (oracleText ?? '').split('\n')) {
    // Reminder text in brackets describes a keyword rather than granting one.
    const line = rawLine.replace(/\([^)]*\)/g, '').trim();
    if (!line) continue;
    // A keyword line is a comma-separated list of keywords and nothing else.
    const parts = line.split(/,\s*/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0 || !parts.every((p) => KEYWORD_SET.has(p))) continue;
    for (const p of parts) found.add(p as Keyword);
  }
  return [...found];
}

/** Colours a card is, from its mana cost's colour requirements plus any colour indicator. */
export function printedColors(def: CardDef | undefined): Color[] {
  const declared = (def?.colors ?? []).map((c) => String(c).toUpperCase());
  return (['W', 'U', 'B', 'R', 'G'] as Color[]).filter((c) => declared.includes(c));
}

export type EffectDuration = 'end-of-turn' | 'end-of-combat' | 'permanent';

/**
 * A continuous effect currently modifying the battlefield.
 *
 * `scope` decides who it applies to. `source` is kept so an effect can be removed when the
 * permanent that made it leaves, which is what makes a static anthem work.
 */
export interface ContinuousEffect {
  readonly id: string;
  readonly source: string;
  readonly controller: SeatIndex;
  readonly scope:
    | { readonly kind: 'cards'; readonly ids: readonly string[] }
    | { readonly kind: 'controller-creatures' }
    /**
     * Every creature its controller has **except the one that made it**.
     *
     * The usual templating on a creature that buffs a team — "*other* creatures you control get
     * +1/+0" — and the difference matters in combat: a 2/2 lord that pumped itself attacks as a
     * 3/2. `source` is what it excludes, which is why a continuous effect keeps it.
     */
    | { readonly kind: 'other-controller-creatures' }
    | { readonly kind: 'all-creatures' };
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  /** Removes keywords, for effects like "loses flying". */
  readonly removeKeywords?: readonly Keyword[];
  /** Blanket "can't attack or block", which is Pacifism and friends. */
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /**
   * Combat damage involving the permanents in scope does not happen — dealt **by** them and dealt
   * **to** them. A Fog is this with an all-creatures scope; a Maze of Ith is it scoped to one card.
   *
   * Carried on a continuous effect rather than built as a prevention subsystem, because everything
   * such an effect needs already exists here: a scope that can name one card or every creature, a
   * duration, an expiry pass, and a source. The engine applies it in exactly one place —
   * `dealCombatDamage` — which is also what keeps the name honest.
   *
   * **Combat damage only, and deliberately so.** "Prevent the next 3 damage" is a different shape:
   * a shield with a quantity that is spent, which has to survive partial use and interact with
   * every source of damage rather than one. Nothing in this pool needs it, and a flag that claimed
   * to prevent damage in general while only covering combat would be worse than one that says what
   * it does.
   */
  readonly preventsCombatDamage?: boolean;
  readonly duration: EffectDuration;
  readonly createdTurn: number;
  /**
   * Set by a temporary control-change effect (Act of Treason and friends): the seat the permanent
   * goes back to when the effect ends. Control is a move between battlefields rather than a
   * modification, so it cannot be expressed as a power or keyword change — the turn logic reads
   * this when the effect expires and moves the permanent home.
   */
  readonly controlRevertTo?: SeatIndex;
}

export interface Characteristics {
  readonly name: string;
  readonly typeLine: TypeLine;
  readonly colors: readonly Color[];
  readonly power: number;
  readonly toughness: number;
  readonly keywords: ReadonlySet<Keyword>;
  readonly isCreature: boolean;
  readonly isLand: boolean;
  readonly cantAttack: boolean;
  readonly cantBlock: boolean;
}

const numeric = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

function effectApplies(effect: ContinuousEffect, instance: CardInstance, creature: boolean): boolean {
  switch (effect.scope.kind) {
    case 'cards':
      return effect.scope.ids.includes(instance.id);
    case 'controller-creatures':
      return creature && instance.zoneSeat === effect.controller;
    case 'other-controller-creatures':
      return creature && instance.zoneSeat === effect.controller && instance.id !== effect.source;
    case 'all-creatures':
      return creature;
    default:
      return false;
  }
}

/**
 * What this permanent currently is.
 *
 * Order: printed values, then continuous effects, then counters. Counters last because `+1/+1`
 * counters apply in layer 7d, after the pumps in 7c — so a 1/1 with a +1/+1 counter that also has
 * "+3/+3 until end of turn" is 5/5 either way, but an effect that *sets* power would not be, and
 * keeping the order right now means that case can be added without re-deriving everything.
 */
export function characteristicsOf(state: GameState, instance: CardInstance): Characteristics {
  const def = state.cardDefs[instance.defKey];
  const typeLine = parseTypeLine(def?.typeLine);
  const creature = hasType(typeLine, 'creature');

  let power = numeric(def?.power);
  let toughness = numeric(def?.toughness);
  const keywords = new Set<Keyword>(printedKeywords(def?.oracleText));
  let cantAttack = false;
  let cantBlock = false;

  for (const effect of state.effects ?? []) {
    if (!effectApplies(effect, instance, creature)) continue;
    power += effect.power ?? 0;
    toughness += effect.toughness ?? 0;
    for (const k of effect.keywords ?? []) keywords.add(k);
    for (const k of effect.removeKeywords ?? []) keywords.delete(k);
    if (effect.cantAttack) cantAttack = true;
    if (effect.cantBlock) cantBlock = true;
  }

  const plus = instance.counters['+1/+1'] ?? 0;
  const minus = instance.counters['-1/-1'] ?? 0;
  power += plus - minus;
  toughness += plus - minus;

  if (hasType(typeLine, 'creature') && keywords.has('defender')) cantAttack = true;

  return {
    name: def?.name ?? 'a card',
    typeLine,
    colors: printedColors(def),
    power,
    toughness,
    keywords,
    isCreature: creature,
    isLand: hasType(typeLine, 'land'),
    cantAttack,
    cantBlock,
  };
}

/**
 * Whether this permanent's combat damage is prevented, in either direction.
 *
 * Asked of the *creature*, not of the attack, because both cards in a fight ask it: an attacker
 * under a Fog deals none, and a blocker under the same Fog deals none back. One question, both
 * directions, which is also how the printed cards read.
 */
export function combatDamagePrevented(state: GameState, instance: CardInstance): boolean {
  const def = state.cardDefs[instance.defKey];
  const creature = hasType(parseTypeLine(def?.typeLine), 'creature');
  return (state.effects ?? []).some(
    (effect) => effect.preventsCombatDamage === true && effectApplies(effect, instance, creature),
  );
}

/** Convenience for the many places that only need to ask about one keyword. */
export function hasKeyword(state: GameState, instance: CardInstance, keyword: Keyword): boolean {
  return characteristicsOf(state, instance).keywords.has(keyword);
}

/** Drops effects whose duration has run out, and those whose source has left the battlefield. */
export function expireEffects(state: GameState, when: EffectDuration): ContinuousEffect[] {
  return (state.effects ?? []).filter((effect) => {
    if (effect.duration === when) return false;
    // A static effect only exists while its source is on the battlefield.
    if (effect.duration === 'permanent') {
      const source = state.instances[effect.source];
      return source !== undefined && source.zone === 'battlefield';
    }
    return true;
  });
}
