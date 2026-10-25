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

export type EffectDuration =
  | 'end-of-turn'
  | 'end-of-combat'
  /**
   * "Until your next turn", where *you* is the effect's own `controller`.
   *
   * The first duration here anchored to a seat rather than to a point in the current turn, and goad
   * is why: a goad cast on somebody else's turn has to survive the end of that turn and every turn
   * in between, then end when the goading player's own turn begins. `end-of-turn` would expire it
   * before the combat it exists to force, which is worse than not having the card.
   *
   * Expired in the untap step, which is the first thing a turn does — so the effect is gone before
   * anybody could read it, rather than lingering through the turn that ends it.
   */
  | 'until-controllers-next-turn'
  | 'permanent';

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
    | { readonly kind: 'all-creatures' }
    /**
     * One player, rather than any permanent.
     *
     * The only scope here that names a seat, and the only one `characteristicsOf` can never match,
     * because a player has no characteristics to modify. It exists for the one kind of effect that
     * has to be able to point at a player the same way it points at a creature: a prevention
     * shield, whose printed target is "any target" (CR 115.4). `effectApplies` says so out loud
     * rather than falling through the default, so the next effect that wants a seat scope finds
     * the question already asked.
     */
    | { readonly kind: 'seat'; readonly seat: SeatIndex };
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  /** Removes keywords, for effects like "loses flying". */
  readonly removeKeywords?: readonly Keyword[];
  /** Blanket "can't attack or block", which is Pacifism and friends. */
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /**
   * "Attacks each combat if able" (CR 508.1d). The opposite of `cantAttack`, and the harder of the
   * two: a restriction is checked against one creature, a *requirement* is checked against the
   * whole declaration — a creature that could have attacked and did not makes the declaration
   * illegal, and "could have" has to account for being tapped, summoning-sick, Pacified, or
   * having nobody legal to attack.
   */
  readonly mustAttack?: boolean;
  /**
   * "Can't be blocked by Walls." A restriction on the *blocker*, read from the attacker, which is
   * the only shape of evasion in this pool that is not a keyword — so it lives here rather than
   * in `Keyword`, and `canBlock` reads it the way `dealCombatDamage` reads `preventsCombatDamage`.
   */
  readonly cantBeBlockedByWalls?: boolean;
  /**
   * "Attacks a player other than you if able" (CR 701.38a) — goad's second half, where *you* is
   * this effect's `controller`.
   *
   * The Comprehensive Rules call this a requirement, like `mustAttack`, but it is enforced as a
   * conditional restriction: the creature may not be aimed at the goading player *while there is
   * another player it could attack instead*. Those are the same rule from two directions, and the
   * restriction is the half a declaration can actually be checked against — and the half a table
   * can keep a player from building.
   *
   * Two goaders cancel out rather than stacking into an impossible demand: if every player the
   * creature could attack has goaded it, no requirement can be met and all of them are legal,
   * which is what "if able" means and what `attackAimIssue` works out.
   */
  readonly mustAttackAnotherPlayer?: boolean;
  /**
   * Protection from each of these colours (CR 702.16).
   *
   * One flag for four rules, which is what makes protection the awkward keyword it is: a creature
   * with protection from red cannot be **d**amaged, **e**nchanted or equipped, **b**locked or
   * **t**argeted by anything red. Each of those four lives somewhere different in this engine —
   * `dealDamage`, `equipTo`, `canBlock`, and target legality — and a keyword that only did three of
   * them would be worse than none, because a player would trust it.
   *
   * Carried as colours rather than as a predicate because that is how every printed version reads,
   * and because the thing it is compared against — a source's colours — is itself a list.
   */
  readonly protectionFrom?: readonly Color[];
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
  /**
   * A shield with a quantity: "prevent the next N damage that would be dealt to <this> this turn"
   * (CR 615.1), where N is what is **left** of it.
   *
   * The shape `preventsCombatDamage` deliberately refused, and the three differences are the whole
   * of it. It is **spent**: each damage event takes what it needs and the remainder stays, so the
   * effect is rewritten rather than only read, and it is removed when it reaches zero rather than
   * when the turn ends. It covers **every** source of damage, not only combat, because that is
   * what the cards say — a Samite Healer answers a Lightning Bolt. And its target can be a
   * **player**, which is why the scope union now has a seat in it.
   *
   * Applied in `dealDamage`, which is the single place damage is ever marked or lost, and applied
   * *before* anything is marked: prevention is not something that can be undone afterwards, and
   * damage that is wholly prevented must also not gain life for a lifelink source or mark a
   * creature deathtouched, because none of it was dealt.
   */
  readonly preventsDamageAmount?: number;
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
  /** "Attacks each combat if able" (CR 508.1d). Checked against the whole declaration. */
  readonly mustAttack: boolean;
  /** "Can't be blocked by Walls", read from the attacker when a block is offered. */
  readonly cantBeBlockedByWalls: boolean;
  /** Protection from these colours (CR 702.16). Empty for almost everything. */
  readonly protectionFrom: readonly Color[];
  /**
   * The seats that have goaded this creature: the controllers of every `mustAttackAnotherPlayer`
   * effect applying to it.
   *
   * A list rather than a flag because the rule is about *who* — "a player other than you" is a
   * different demand from each goader, and the answer to "may this attack seat 2" depends on which
   * of them did it. `attackAimIssue` is the only thing that should read it.
   */
  readonly goadedBy: readonly SeatIndex[];
}

/** Shared empties, so the common case allocates nothing at all. */
const NO_SEATS: readonly SeatIndex[] = Object.freeze([]);
const NO_COLORS: readonly Color[] = Object.freeze([]);

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
    // A seat scope is about the player, not their permanents: nothing on the battlefield is in it.
    case 'seat':
      return false;
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
  let mustAttack = false;
  let cantBeBlockedByWalls = false;
  /*
    Allocated only if something actually sets them, because this is the hottest function in the
    engine: the search calls it for every candidate of every target of every play it plays out. Two
    `Set`s and two array copies on every call, for two rules that one card in the pool has between
    them, is work done for nothing.

    Not justified by a measurement. The slow tail of a pod soak was what first pointed here, and
    that tail turned out to be divergence noise rather than cost (D101) — the mean per decision
    kind, which is the instrument that does work, puts this below its resolution. It stays because
    allocating nothing is simpler than allocating something, not because a number says so.
  */
  let goadedBy: SeatIndex[] | null = null;
  let protectionFrom: Color[] | null = null;

  for (const effect of state.effects ?? []) {
    if (!effectApplies(effect, instance, creature)) continue;
    power += effect.power ?? 0;
    toughness += effect.toughness ?? 0;
    for (const k of effect.keywords ?? []) keywords.add(k);
    for (const k of effect.removeKeywords ?? []) keywords.delete(k);
    if (effect.cantAttack) cantAttack = true;
    if (effect.cantBlock) cantBlock = true;
    if (effect.mustAttack) mustAttack = true;
    if (effect.cantBeBlockedByWalls) cantBeBlockedByWalls = true;
    if (effect.mustAttackAnotherPlayer) {
      goadedBy ??= [];
      if (!goadedBy.includes(effect.controller)) goadedBy.push(effect.controller);
    }
    for (const colour of effect.protectionFrom ?? []) {
      protectionFrom ??= [];
      if (!protectionFrom.includes(colour)) protectionFrom.push(colour);
    }
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
    // A creature that cannot attack at all is not required to: a restriction beats a requirement
    // (CR 509.1a is the blocking half of the same idea, and 508.1d says "if able").
    mustAttack: mustAttack && !cantAttack,
    cantBeBlockedByWalls,
    goadedBy: goadedBy ?? NO_SEATS,
    protectionFrom: protectionFrom ?? NO_COLORS,
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

/**
 * Whether `target` has protection from anything `source` is (CR 702.16).
 *
 * One answer for all four of protection's rules — damage, equipping, blocking and targeting — so
 * that the four cannot disagree about what "red" means. `source` is an instance id: a permanent, or
 * a spell on the stack, whose id *is* its card instance. A source with no instance (a game rule, or
 * damage from nowhere) is colourless and so gets past protection, which is correct: protection is
 * from colours, not from everything.
 */
export function protectedFrom(state: GameState, targetId: string, source: string | null): boolean {
  if (source === null) return false;
  const target = state.instances[targetId];
  if (target === undefined) return false;
  return protectionApplies(state, characteristicsOf(state, target).protectionFrom, source);
}

/**
 * The same question for a caller that already has the characteristics in hand.
 *
 * Which is every caller in a hot loop: target legality computes the characteristics for each
 * candidate, and `canBlock` for each blocker, so asking through `protectedFrom` would compute them
 * a second time per candidate — the one measurable part of which is that it is twice the work for
 * the same answer. The empty-list check first is what makes the whole rule free for the 152 cards
 * in the pool that have no protection, which is the case that matters.
 */
export function protectionApplies(
  state: GameState, protection: readonly Color[], source: string | null,
): boolean {
  if (protection.length === 0 || source === null) return false;
  const inst = state.instances[source];
  if (inst === undefined) return false;
  return printedColors(state.cardDefs[inst.defKey]).some((colour) => protection.includes(colour));
}

/** Convenience for the many places that only need to ask about one keyword. */
export function hasKeyword(state: GameState, instance: CardInstance, keyword: Keyword): boolean {
  return characteristicsOf(state, instance).keywords.has(keyword);
}

/**
 * Drops effects whose duration has run out, and those whose source has left the battlefield.
 *
 * `seat` is only read for `until-controllers-next-turn`, where the duration names a seat rather
 * than a moment: that effect ends on its own controller's turn and nobody else's, so the untap
 * step passes the seat whose turn has just begun. Leaving it out can never expire one, which is
 * what the end-of-turn and end-of-combat passes want.
 */
export function expireEffects(
  state: GameState, when: EffectDuration, seat?: SeatIndex,
): ContinuousEffect[] {
  return (state.effects ?? []).filter((effect) => {
    if (effect.duration === 'until-controllers-next-turn') {
      // Not on the turn it was made in: a goad cast in a player's own turn lasts until their
      // *next* one, and the untap it was created after has already gone by.
      const ends = when === 'until-controllers-next-turn'
        && effect.controller === seat && effect.createdTurn < state.turn;
      return !ends;
    }
    if (effect.duration === when) return false;
    // A static effect only exists while its source is on the battlefield.
    if (effect.duration === 'permanent') {
      const source = state.instances[effect.source];
      return source !== undefined && source.zone === 'battlefield';
    }
    return true;
  });
}
