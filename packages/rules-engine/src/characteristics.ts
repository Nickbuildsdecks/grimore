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
 * layers with timestamps and dependency ordering (CR 613). What is here is a fixed order that
 * produces the same answer for everything the pool contains: copying (layer 1), type and colour
 * changes (4 and 5), granted and removed abilities (6), then the three sublayers of power and
 * toughness in the order the rules put them — characteristic-setting (7b) before a pump (7c)
 * before counters (7d). Each of those arrived with a card behind it (D88, D93, D94), so a Clone
 * that copied a creature under a Giant Growth and three +1/+1 counters answers correctly.
 *
 * What is still missing is **timestamps and dependency**: two effects that disagree inside one
 * layer are applied in the order the list happens to hold them rather than in the order they were
 * created. Nothing in the pool produces that disagreement, and a card that would is better left
 * unscripted than answered plausibly and wrongly.
 */
import { isFaceDownObject, isFaceDownPermanent, zoneKey, type CardDef, type CardInstance } from './cards.js';
import type { Color } from './mana.js';
import type { GameState, SeatIndex } from './types.js';

export const KEYWORDS = [
  'flying', 'reach', 'vigilance', 'haste', 'trample', 'first strike', 'double strike',
  'deathtouch', 'lifelink', 'hexproof', 'shroud', 'indestructible', 'menace', 'defender',
  'prowess', 'flash', 'infect',
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
    /**
     * Every creature of one type its controller has — "other Goblin creatures you control get
     * +1/+1", and every tribal lord ever printed.
     *
     * The only scope here that carries a value, which is why `other` is a field on it rather than a
     * second `kind` the way `other-controller-creatures` is: a parameterised scope already has to
     * be read rather than matched, so one more field costs nothing, where two bare tags would have
     * become four.
     *
     * Matched against the type line **after layer 4** wherever the caller has one (CR 613.1d before
     * 613.1f), so a permanent that was *given* a creature type is in the scope. No card in the pool
     * adds a subtype yet, so that half is ordering rather than a feature anything uses — it has a
     * test built on a hand-made effect, because the ordering is the kind of thing that is free to
     * get right now and expensive to discover later. The two callers that have only the printed
     * line are the layer-4 pass itself, which cannot have its own output, and
     * `combatDamagePrevented`, where nothing in the pool cares.
     */
    | {
        readonly kind: 'controller-subtype';
        readonly subtype: string;
        /** "**Other** Goblin creatures", which is how almost every lord is worded. */
        readonly other?: boolean;
      }
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
   * "Can't be blocked" with nothing after it — the absolute kind of evasion, which this pool had
   * none of. Read off the attacker by `canBlock`, like `cantBeBlockedByWalls`.
   */
  readonly cantBeBlocked?: boolean;
  /**
   * **Landwalk**: the land subtypes this creature cannot be blocked while the *defending player*
   * controls (CR 702.14). "Islandwalk" is `['Island']`.
   *
   * A list rather than a flag, and a list of subtypes rather than an enum, because the question is
   * a parameter: there is one landwalk rule and a dozen land types, which is the same argument
   * `statics`' subtype scope settled (D57). What makes it different from every other evasion here
   * is *where* it is read — the attacker says which subtype, and the answer is on the other
   * player's battlefield at the moment blockers are declared, which is why it cannot be a keyword
   * and cannot be decided when the attack is declared.
   */
  readonly landwalk?: readonly string[];
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
  /**
   * Power and toughness **set** to these, rather than added to: layer 7b (CR 613.4c).
   *
   * The difference from `power`/`toughness` is the whole of why this engine needed layers at all.
   * A +3/+3 and a -1/-1 can be summed in any order and come to the same answer; "becomes 1/1"
   * cannot be summed with anything — it replaces the base, and every modification applies *after*
   * it however early it was cast. A Giant Growth cast before a Turn to Frog leaves a 4/4, not a
   * 1/1, and that is not a quirk: setting is layer 7b and modifying is 7c, and the layers run in
   * order regardless of timestamps.
   *
   * Two settings on one creature resolve by timestamp, last one wins, which `characteristicsOf`
   * gets for free by reading `state.effects` in the order they were created.
   */
  readonly setPower?: number;
  readonly setToughness?: number;
  /**
   * "Loses all abilities": layer 6 (CR 613.1f), and the one layer where timestamps are the rule
   * rather than a tie-break.
   *
   * An ability granted *before* this effect is gone; one granted *after* it survives. That is why
   * abilities are accumulated in effect order and this clears what has been collected so far
   * rather than setting a flag read at the end — the order of the list is the timestamp order, so
   * the rule falls out of the loop instead of needing a second pass.
   *
   * Printed keywords go too, which is what makes a Turn to Frog answer a flier.
   */
  readonly losesAllAbilities?: boolean;
  /**
   * Card types this effect adds: layer 4 (CR 613.1c). "Becomes a creature", and nothing yet takes
   * a type away.
   *
   * Applied in a pass of its own before anything else, because what a permanent *is* decides which
   * later effects apply to it: an animated land is a creature, so an anthem that pumps "creatures
   * you control" pumps it (CR 613.1c runs before 613.1g).
   */
  readonly addTypes?: readonly string[];
  /** Subtypes this effect adds, for the same layer. */
  readonly addSubtypes?: readonly string[];
  /**
   * A characteristic-defining ability: layer 7a (CR 613.4a), and the one layer whose answer is a
   * fact about the board rather than a number somebody wrote down.
   *
   * "Lhurgoyf's power is equal to the number of creature cards in all graveyards and its toughness
   * is equal to that plus 1" — so it shrinks when a graveyard is exiled and grows when anything
   * dies, with no event anywhere and nothing to recompute. That is why it is a `count` to perform
   * rather than a closure to call: `GameState` is stored in Redis and sent over a socket, so an
   * effect carrying a function would be an effect that cannot be saved. The engine owns the
   * counting; the card says which count it is.
   *
   * It defines the *base*, so layer 7b still beats it (a Turn to Frog on a Lhurgoyf is a 1/1) and
   * 7c and 7d still land on top (a Giant Growth makes it three bigger than whatever it is).
   */
  readonly definesSize?: {
    /**
     * One count, because one card needs one count. "Cards in your hand", "lands you control" and
     * the rest are each a line in `cdaCount` and a card away — and a clause with no card behind it
     * is a clause nothing has ever run (D57), so they are named here rather than written.
     */
    readonly count:
      | 'creature-cards-in-graveyards'
      | 'instant-and-sorcery-cards-in-your-graveyard';
    /**
     * Which of the two the count defines. `both` is a Lhurgoyf, whose power and toughness are both
     * the count; `power` is the Drake printed with a star for power and a 4 for toughness, where
     * only the power is counted. Defaulting to `both` leaves the card that shipped first unchanged.
     */
    readonly applies?: 'both' | 'power';
    readonly powerPlus?: number;
    readonly toughnessPlus?: number;
  };
  /**
   * The colours this permanent becomes: layer 5 (CR 613.1d).
   *
   * Setting rather than adding, because that is what the cards say — "becomes red" *replaces* the
   * printed colours (CR 105.3), while "is also red" would add to them and nothing in the pool does.
   * Last one wins, like layer 7b.
   */
  readonly setColors?: readonly Color[];
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
  /** "Can't be blocked" outright, read from the attacker when a block is offered. */
  readonly cantBeBlocked: boolean;
  /** Landwalk subtypes, checked against the *defending* player's lands (CR 702.14). */
  readonly landwalk: readonly string[];
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
/** Shared empty list, so a creature with no landwalk allocates nothing. */
const NO_SUBTYPES: readonly string[] = Object.freeze([]);
const NO_COLORS: readonly Color[] = Object.freeze([]);

const numeric = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `typeLine` is passed separately from `creature` rather than derived from it, because `creature`
 * is computed once per `characteristicsOf` call and this runs once per effect: re-deriving it here
 * would put a type-line scan on the hottest loop in the engine for the sake of one scope that
 * almost nothing uses.
 */
function effectApplies(
  effect: ContinuousEffect, instance: CardInstance, creature: boolean, typeLine: TypeLine,
): boolean {
  switch (effect.scope.kind) {
    case 'cards':
      return effect.scope.ids.includes(instance.id);
    case 'controller-creatures':
      return creature && instance.zoneSeat === effect.controller;
    case 'other-controller-creatures':
      return creature && instance.zoneSeat === effect.controller && instance.id !== effect.source;
    case 'controller-subtype':
      return creature && instance.zoneSeat === effect.controller
        && !(effect.scope.other === true && instance.id === effect.source)
        && hasSubtype(typeLine, effect.scope.subtype);
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
 * What a characteristic-defining ability counts, right now.
 *
 * Counted on every read, which is what makes it a CDA rather than an effect: there is no moment at
 * which the number is decided, so there is nothing to store and nothing to invalidate.
 */
function cdaCount(
  state: GameState,
  kind: NonNullable<ContinuousEffect['definesSize']>['count'],
  controller: SeatIndex,
): number {
  // Whose graveyards are counted is part of what the card says, so it is read off the kind rather
  // than passed in: "in all graveyards" and "in your graveyard" are two different counts, and a
  // card that said one while the engine performed the other would be wrong in the quiet way.
  const seats = kind === 'instant-and-sorcery-cards-in-your-graveyard'
    ? [controller]
    : state.seats.map((row) => row.index);
  let total = 0;
  for (const seat of seats) {
    for (const id of state.zones[zoneKey(seat, 'graveyard')] ?? []) {
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const line = parseTypeLine(state.cardDefs[inst.defKey]?.typeLine);
      const counts = kind === 'creature-cards-in-graveyards'
        ? hasType(line, 'creature')
        : hasType(line, 'instant') || hasType(line, 'sorcery');
      if (counts) total += 1;
    }
  }
  return total;
}

/**
 * The type line with layer 4 applied, or the printed one when nothing changes it.
 *
 * Returns the *same object* when no effect adds a type, which is the common case by a very long
 * way: this runs on the hottest path in the engine, and a type line rebuilt on every call would be
 * two array copies per permanent per candidate per playout.
 */
function withAddedTypes(
  state: GameState, instance: CardInstance, printed: TypeLine, printedCreature: boolean,
): TypeLine {
  let types: string[] | null = null;
  let subtypes: string[] | null = null;
  for (const effect of state.effects ?? []) {
    if (effect.addTypes === undefined && effect.addSubtypes === undefined) continue;
    if (silenced(state, effect.source)) continue;
    if (!effectApplies(effect, instance, printedCreature, printed)) continue;
    for (const type of effect.addTypes ?? []) {
      if (hasType(printed, type) || (types !== null && types.includes(type))) continue;
      types = [...(types ?? []), type];
    }
    for (const sub of effect.addSubtypes ?? []) {
      if (printed.subtypes.includes(sub) || (subtypes !== null && subtypes.includes(sub))) continue;
      subtypes = [...(subtypes ?? []), sub];
    }
  }
  if (types === null && subtypes === null) return printed;
  return {
    supertypes: printed.supertypes,
    types: types === null ? printed.types : [...printed.types, ...types],
    subtypes: subtypes === null ? printed.subtypes : [...printed.subtypes, ...subtypes],
  };
}

/**
 * What a face-down permanent is, instead of what its card says (CR 707.2).
 *
 * A 2/2 creature with no name, no mana cost, no creature types and no abilities, whether it is on
 * the battlefield or still a spell on the stack (CR 707.4). Substituted for the card at the top of
 * `characteristicsOf` rather than special-cased through it, so every layer
 * below applies to *this* instead: a Giant Growth on a face-down creature still makes it a 5/5, a
 * +1/+1 counter still makes it a 3/3, and an anthem still lifts it, which is the rule.
 *
 * The bug this fixes was visible from both sides of a table. Any player may turn a permanent face
 * down, and `viewFor` has always hidden its identity from everybody else — but nothing hid it from
 * the *rules*, so a face-down Hill Giant was a card the opponent could not see and a 3/3 that
 * fought like a Hill Giant. Two players looking at one board with different facts.
 */
const FACE_DOWN: CardDef = Object.freeze({
  name: 'a face-down creature',
  typeLine: 'Creature',
  manaCost: '',
  cmc: 0,
  power: '2',
  toughness: '2',
  oracleText: '',
  colors: [],
});

/**
 * Whether a continuous effect's source has been turned face down, and so has no abilities to grant.
 *
 * A face-down permanent has no abilities at all (CR 707.2), including the static ones it was
 * handing out while it was face up: turn a Glorious Anthem face down and the team shrinks. Checked
 * where each effect is read rather than by removing the effect when the card is turned over —
 * "detect, don't announce" — because a permanent turned back face up has its abilities again, and
 * an effect that was deleted could not come back.
 *
 * One lookup rather than a filtered copy of `state.effects`: `characteristicsOf` runs on every
 * read of every permanent, and the comments in it about allocating nothing mean it.
 */
function silenced(state: GameState, source: string | undefined): boolean {
  if (source === undefined) return false;
  const inst = state.instances[source];
  return inst !== undefined && isFaceDownPermanent(inst);
}

/**
 * What this permanent currently is.
 *
 * **The layers, in the order CR 613 runs them**, for the four this engine has cards for:
 *
 *  1. **copy** (613.1a) — not computed here at all. A copy is a copy of a *printed* card, so the
 *     engine makes one by pointing the instance at the copied card's definition: by the time this
 *     function runs there is nothing left to apply, and `scriptFor` finds the copied card's
 *     abilities for free. That is also why a token copy of a Fog Bank prevents damage.
 *  2. **type-changing** (613.1c) — "becomes a creature", in a pass of its own; see
 *     `withAddedTypes` for why it cannot share the loop below.
 *  3. **colour-changing** (613.1d) — "becomes red", replacing the printed colours, last one wins.
 *  4. **abilities** (613.1f) — keywords granted and removed, and "loses all abilities", which
 *     clears everything collected *before* it and lets later grants through. Accumulated in effect
 *     order, which is timestamp order, so the rule needs no second pass.
 *  5. **a defined size** (7a, 613.4a) — a characteristic-defining ability, which is a count of
 *     something on the table rather than a number: it changes when the board does, with no event
 *     and nothing to recompute. See `cdaCount`.
 *  6. **setting power and toughness** (7b, 613.4c) — replaces the printed base; two of them resolve
 *     last-one-wins.
 *  7. **modifying power and toughness** (7c) — every pump and anthem, summed, applied *after* any
 *     setting however early it was cast.
 *  8. **counters** (7d) — `+1/+1` and `-1/-1`, last of all.
 *
 * Type-changing (layer 4) and colour-changing (5) are in as well, and layer 4 is the reason this
 * function makes two passes rather than one: a permanent's types decide which *other* effects
 * apply to it, so "becomes a creature" has to be known before the scope of an anthem is judged.
 * Which is all of CR 613 that the cards in this pool need. What is not here is dependency ordering
 * between effects in the same layer (613.8), which no two cards in the pool argue about.
 */
export function characteristicsOf(state: GameState, instance: CardInstance): Characteristics {
  /*
    Face down matters on the battlefield and on the stack, and nowhere else. A card face down in
    exile is a card nobody can read, which is what `viewFor` is for; it has no characteristics to
    get wrong because nothing fights it, and treating it as a 2/2 creature there would make exile
    a battlefield.
  */
  const def = isFaceDownObject(instance) ? FACE_DOWN : state.cardDefs[instance.defKey];
  const printed = parseTypeLine(def?.typeLine);
  /*
    Layer 4 first, in a pass of its own (CR 613.1c).

    It has to be separate because every later layer's *scope* depends on its result: "creatures you
    control get +1/+1" applies to a land that has become a creature, and a single pass in effect
    order would have judged that against the printed type line and missed it. The scope of a
    type-changing effect itself is judged against the printed types, which is the one simplification
    left in here — a card that animates something another effect animated first would need this pass
    to iterate, and nothing in the pool asks for it.
  */
  const typeLine = withAddedTypes(state, instance, printed, hasType(printed, 'creature'));
  const creature = hasType(typeLine, 'creature');

  // Layer 7b and 7c are collected separately, because the first replaces the base and the second
  // adds to whatever the base ended up being.
  let definedPower: number | null = null;
  let definedToughness: number | null = null;
  let setPower: number | null = null;
  let setToughness: number | null = null;
  let modPower = 0;
  let modToughness = 0;
  const keywords = new Set<Keyword>(printedKeywords(def?.oracleText));
  let cantAttack = false;
  let cantBlock = false;
  let mustAttack = false;
  let cantBeBlockedByWalls = false;
  let cantBeBlocked = false;
  let landwalk: string[] | null = null;
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
  let setColors: readonly Color[] | null = null;

  for (const effect of state.effects ?? []) {
    if (silenced(state, effect.source)) continue;
    if (!effectApplies(effect, instance, creature, typeLine)) continue;
    /*
      Layer 6, and the one place the order of this loop is load-bearing.

      "Loses all abilities" takes away what the creature has *now* — its printed keywords and
      anything granted before this effect — and leaves anything granted after it alone (CR 613.1f).
      `state.effects` is in creation order, so clearing here is exactly that rule: a Turn to Frog
      cast after a Giant Growth's trample still removes it, and a trample granted after the Frog
      still flies.
    */
    if (effect.losesAllAbilities === true) {
      keywords.clear();
      cantAttack = false;
      cantBlock = false;
      mustAttack = false;
      cantBeBlockedByWalls = false;
      cantBeBlocked = false;
      landwalk = null;
      goadedBy = null;
      protectionFrom = null;
    }
    // Layer 7a before 7b, which is the whole of the ordering: a defined size is a *base*, and a
    // setting effect replaces it however early the definition was installed (CR 613.4a, 613.4c).
    if (effect.definesSize !== undefined) {
      const counted = cdaCount(state, effect.definesSize.count, effect.controller);
      definedPower = counted + (effect.definesSize.powerPlus ?? 0);
      if (effect.definesSize.applies !== 'power') {
        definedToughness = counted + (effect.definesSize.toughnessPlus ?? 0);
      }
    }
    if (effect.setPower !== undefined) setPower = effect.setPower;
    if (effect.setToughness !== undefined) setToughness = effect.setToughness;
    modPower += effect.power ?? 0;
    modToughness += effect.toughness ?? 0;
    for (const k of effect.keywords ?? []) keywords.add(k);
    for (const k of effect.removeKeywords ?? []) keywords.delete(k);
    if (effect.cantAttack) cantAttack = true;
    if (effect.cantBlock) cantBlock = true;
    if (effect.mustAttack) mustAttack = true;
    if (effect.cantBeBlockedByWalls) cantBeBlockedByWalls = true;
    if (effect.cantBeBlocked) cantBeBlocked = true;
    for (const subtype of effect.landwalk ?? []) {
      landwalk ??= [];
      if (!landwalk.includes(subtype)) landwalk.push(subtype);
    }
    if (effect.mustAttackAnotherPlayer) {
      goadedBy ??= [];
      if (!goadedBy.includes(effect.controller)) goadedBy.push(effect.controller);
    }
    for (const colour of effect.protectionFrom ?? []) {
      protectionFrom ??= [];
      if (!protectionFrom.includes(colour)) protectionFrom.push(colour);
    }
    // Layer 5 (CR 613.1d), which only has to be in effect order to be right: two effects that both
    // set a colour resolve last-one-wins, the same way two that set power do.
    if (effect.setColors !== undefined) setColors = effect.setColors;
  }

  // 7b, then 7c, then 7d: the base is whatever the last setting effect said (or the printed
  // value), every modification lands on top of it, and counters land on top of those.
  const plus = instance.counters['+1/+1'] ?? 0;
  const minus = instance.counters['-1/-1'] ?? 0;
  // 7a, then 7b, then 7c, then 7d: a defined size replaces the printed one, a setting effect
  // replaces either, every modification lands on top, and counters land on top of those.
  const base = setPower ?? definedPower ?? numeric(def?.power);
  const baseToughness = setToughness ?? definedToughness ?? numeric(def?.toughness);
  const power = base + modPower + plus - minus;
  const toughness = baseToughness + modToughness + plus - minus;

  if (hasType(typeLine, 'creature') && keywords.has('defender')) cantAttack = true;

  return {
    name: def?.name ?? 'a card',
    typeLine,
    colors: setColors ?? printedColors(def),
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
    cantBeBlocked,
    landwalk: landwalk ?? NO_SUBTYPES,
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
  const line = parseTypeLine(def?.typeLine);
  const creature = hasType(line, 'creature');
  return (state.effects ?? []).some(
    (effect) => effect.preventsCombatDamage === true
      && effectApplies(effect, instance, creature, line),
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
  /*
    The source's *current* colours, not its printed ones — which is what layer 5 is for and what
    this read got wrong until a card could change a colour. A creature made red is red to
    protection from red, and this is the only rule in the engine that asks.

    `characteristicsOf` rather than `printedColors` costs a characteristics computation per source,
    and it is behind the empty-protection check above: 152 of the cards in the pool have no
    protection at all, so for them nothing here runs. For the two that do, the right answer is
    worth the work.
  */
  return characteristicsOf(state, inst).colors.some((colour) => protection.includes(colour));
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
