/**
 * The vocabulary card scripts are written in.
 *
 * Every function here takes a state and returns a new one, so a script is a composition rather than
 * a sequence of mutations — which is what lets the same effect run during resolution, during a
 * trigger, and inside a test with no setup. They are deliberately small and literal: `dealDamage`
 * marks damage and does not check whether anything died, because dying is a state-based action and
 * belongs to the engine, not to Lightning Bolt.
 *
 * Nothing here chooses anything, and that is the rule rather than a limitation. A target was
 * chosen when the spell was cast; a decision made *during* resolution — searching a library, an
 * opponent's own-choice discard — was asked for by the engine and answered by a player before the
 * effect ran, and arrives in `ctx.decisions` the same way. An effect that picked for itself would
 * be a tutor that chooses your card for you, which is worse than one you resolve by hand.
 */
import type { CardScript } from './scriptTypes.js';
import {
  allAbilitiesLost, characteristicsOf, THE_RING, countersAfterReplacement, effectReaches, type CreatureKindWord, hasType, parseTypeLine, playerProtected, printedColors, protectedFrom, tokenMultiplier, treasureBonus, registerCounterMarkers, type ContinuousEffect,
  type EffectDuration, type Keyword,
} from './characteristics.js';
import { defKeyFor, facesOf, zoneKey, type CardDef, type CardInstance } from './cards.js';
import {
  drawFromLibrary, listAt, normaliseDef, relocate, requireInstance, withInstance, withZones,
} from './cardActions.js';
import { actionSeed, clampValue, mulberry32, replaceSeat, shuffled } from './internal.js';
import { targetSeqsFor, usePlayerShield } from './targeting.js';
import type { Color, ManaType } from './mana.js';
import { addMana, costValue, EMPTY_POOL, parseManaCost, xMultiplier } from './mana.js';
import type { AttackedTarget, DecisionAnswer, SacrificedStats, StackObject, Step, Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/** What an effect is given when it runs. */
export interface EffectContext {
  readonly state: GameState;
  /** The permanent or spell the effect comes from. */
  readonly source: string;
  readonly controller: SeatIndex;
  readonly targets: readonly Target[];
  /** See \`StackObject.targetSlots\` (D953): the targets as chosen, \`null\` where one has gone. */
  readonly targetSlots?: readonly (Target | null)[];
  /** The chosen value of X, 0 when the cost had none. */
  readonly x: number;
  /**
   * Answers to the questions this spell or ability asked while resolving, in the order its
   * `decisions` asked them. Empty for everything that asks nothing — which is almost everything.
   */
  readonly decisions: readonly DecisionAnswer[];
  /** Whether this spell's kicker was paid (CR 702.32a). False for everything without one. */
  readonly kicked: boolean;
  /**
   * The spell itself, while it resolves (D715): "if this spell was cast from a graveyard" reads its
   * `castFrom`, and Sevinne's Reclamation copies it. Absent for abilities. The object has already
   * left the stack by the time the effect runs.
   */
  readonly resolving?: StackObject;
  /**
   * "It can't be regenerated." — set for the whole of **one resolution**, and read by every destroy
   * that resolution performs (D535).
   *
   * On the context rather than on the clause, because the sentence is not about a clause: it is a
   * modifier on its sibling. "Destroy target nonblack creature. It can't be regenerated." is one
   * effect with a rider, and 134 legal cards print the rider on eleven different destroy shapes —
   * a targeted destroy, four sweepers, an activated ability, an upkeep trigger, a combat-damage
   * trigger. A reader per shape is the long tail D530 exists to avoid; a flag the destroys read is
   * one change that covers every shape the vocabulary can already read, and every shape it learns.
   *
   * Absent means "regeneration applies", which is the rule (CR 701.15). Only `true` is ever set, so
   * a context built without the field behaves exactly as it did before this existed.
   */
  readonly noRegeneration?: true;
  /**
   * The countered spell is **exiled** rather than buried (D545).
   *
   * `noRegeneration`'s sibling, in every sense: a printed sentence that modifies the clause beside
   * it rather than doing anything itself — "Counter target spell. If that spell is countered this
   * way, exile it instead of putting it into its owner's graveyard." Twenty legal cards print it,
   * and what it changes is not small: a buried spell can be recast from the graveyard, raised by a
   * reanimator or dredged back, and exiling it is the whole reason Dissipate costs one more than
   * Cancel.
   *
   * On the context because the rider is a fact about the **resolution**: `composeEffects` runs the
   * parts in order and a later part cannot reach back into an earlier one, so the flag is set
   * around the whole composition and every counter in it reads it. That covers the plain counter,
   * the filtered counters, and the "unless its controller pays {N}" form — whose counter happens
   * later still, at `settlePayment`, so the flag travels on `pendingPayment` from here.
   *
   * Absent means the graveyard, which is the rule (CR 701.5a).
   */
  readonly exileWhenCountered?: true;
  /**
   * Remand's and Memory Lapse's rider (D1337): "If that spell is countered this way, put it into
   * its owner's hand / on top of its owner's library instead of into that player's graveyard."
   */
  readonly counteredTo?: 'hand' | 'library-top';
  /**
   * The seat a **possessive referent** names — "Its controller loses 2 life" — computed once, as
   * the resolution begins (D537).
   *
   * On the context, and computed up front, because of the order the printed sentence puts things
   * in: "Destroy target creature. Its controller loses 2 life" destroys the creature *first*, so by
   * the time the second clause runs the object has left the battlefield and the game has to use
   * last known information for it (CR 608.2h). A supply that looked the controller up when the
   * clause ran would find a card in a graveyard and either refuse — the clause silently doing
   * nothing, which is the biggest printed shape in the family — or read the graveyard's seat, which
   * is the card's **owner** and not its controller for anything that had been stolen.
   *
   * Set by `composeEffects` around the whole composition, for the same reason `noRegeneration` is:
   * the fact belongs to the resolution rather than to a clause, and a wrapper is the only place
   * that can see the board before any part has changed it.
   */
  readonly referentSeat?: SeatIndex;
  /**
   * What the attack that caused this trigger was aimed at, for an attack trigger that has to say
   * "the player or planeswalker it's attacking". Undefined for everything else.
   */
  readonly attacked?: AttackedTarget;
  /** The damage the triggering event dealt (D903). See `StackObject.eventAmount`. */
  readonly eventAmount?: number;
  /**
   * The attacker a block trigger's block was against, for a card that has to say "that creature".
   * Undefined for everything else. See `StackObject.blocked`.
   */
  readonly blocked?: string;
  /**
   * The object on the stack this trigger is about, for a ward that has to say "counter **it**".
   * Undefined for everything else. See `StackObject.answering`.
   */
  readonly answering?: string;
  /**
   * The player whose action caused this trigger, for a trigger that has to say "**that** player".
   * Undefined for everything else, and never the ability's own controller when it is set — that is
   * `controller`. See `StackObject.actor`.
   */
  readonly actor?: SeatIndex;
  /**
   * The permanent the event that caused this trigger happened to, for a trigger that has to say
   * "**that** creature" (CR 603.3d). Undefined for everything else.
   *
   * The three board-watching events — a creature entering, dying, attacking — already said *whose*
   * creature it was and whether it was a creature at all; this is *which*. Without it a card can
   * watch the board and then only talk about itself, which rules out an entire shape of printed
   * card: exalted pumps the creature that attacked, evolve measures the creature that entered, and
   * neither has anything to point at.
   *
   * By instance id rather than as a `Target`, because it is not one: nothing chose it, an opponent
   * cannot make it illegal, and a trigger that reads it has no target at all. See
   * `StackObject.subject`.
   */
  readonly subject?: string;
  /**
   * The attack this ability's source is about to join, for an effect that puts a permanent onto the
   * battlefield already attacking. See `StackObject.enteringAttack` and `enterAttacking`.
   */
  readonly enteringAttack?: { readonly defender: SeatIndex; readonly planeswalker?: string };
  /**
   * The counters the permanent this trigger is about had before the event, by counter name.
   *
   * Undefined for everything that is not a death trigger, and for a permanent that had none. It
   * exists because a card in a graveyard has no counters — `relocate` takes them off, which is the
   * rule — so "for each +1/+1 counter on it" has to be answered from what was true when it died
   * (CR 608.2h). See `StackObject.subjectCounters`.
   */
  readonly subjectCounters?: Readonly<Record<string, number>>;
  /** The subject's power and toughness as the event happened (D1020). See `StackObject.subjectStats`. */
  readonly subjectStats?: { readonly power: number; readonly toughness: number };
  /**
   * Each card target's power and toughness as the composed resolution began (D1080), by id: the
   * last known information "its toughness" asks for once the clause before has destroyed or exiled
   * the creature (CR 608.2h). A target still on the battlefield is read live instead.
   */
  readonly targetStats?: Readonly<Record<string, { readonly power: number; readonly toughness: number }>>;
  /**
   * Every card a question of the composed resolution chose, in order (D1081): "Target player
   * sacrifices a creature. You gain life equal to that creature's toughness" asks about the card the
   * first part's question picked, which the part after it cannot see in its own slice of the
   * answers. Their power and toughness are in `targetStats` too, as the resolution began.
   */
  readonly composedChosen?: readonly string[];
  /**
   * The permanent sacrificed to pay for this spell or ability, as it last was (D586).
   *
   * Undefined for everything that sacrificed nothing as a cost. `subjectCounters`' neighbour and
   * for the same rule: "the sacrificed creature's power" is asked of a card that is already in a
   * graveyard, so it is answered from what was true when it left. See `SacrificedStats`.
   */
  readonly sacrificed?: SacrificedStats;
  /**
   * The card types of each permanent the clause before this one destroyed (D682), as they were on
   * the battlefield: Bane of Progress's "Put a +1/+1 counter on ~ for each permanent destroyed this
   * way". Set only between the two sentences `clausesOf` holds together; see `destroyedThisWay`.
   */
  readonly destroyedThisWay?: readonly {
    readonly types: readonly string[];
    /** Who controlled it as it left (D704): Terastodon's "its controller creates …". */
    readonly controller: SeatIndex;
    /** Whether it reached a graveyard, for "put into a graveyard this way" (D704). */
    readonly toGraveyard: boolean;
    /** Whether it was exiled, for "exiled this way" (D1359). */
    readonly toExile?: boolean;
  }[];
  /**
   * The total power of the creatures tapped to pay this ability's cost, as they were (D637): a
   * Spacecraft's station puts that many charge counters on it.
   */
  readonly tappedPower?: number;
  /**
   * The face the source showed when this ability was put on the stack — its `defKey` then (D592).
   *
   * For one rule: a permanent's own ability that transforms it does so only if it has not
   * transformed since the ability was put on the stack (CR 701.28f). Activate "{2}: Transform ~"
   * twice in response to itself and the second resolution must not turn it back. Undefined for
   * everything but an activated or triggered ability's resolution.
   */
  readonly sourceFace?: string;
  /**
   * How much of a divided quantity each of `targets` was assigned, position by position
   * (CR 601.2d). Undefined for everything that divides nothing.
   *
   * Already filtered to match `targets`: a target that became illegal is gone from both lists by
   * the time an effect runs, so position `i` of one is position `i` of the other and the share of
   * a target that is no longer there is simply not in the list. See `dividedAmong`.
   */
  readonly division?: readonly number[];
}

export type EffectFn = (ctx: EffectContext) => GameState;

// ── Reading the board ────────────────────────────────────────────────────────────────────────────

export const poolOf = (state: GameState, seat: SeatIndex) => state.pools[String(seat)] ?? EMPTY_POOL;

export function setPool(state: GameState, seat: SeatIndex, pool: typeof EMPTY_POOL): GameState {
  return { ...state, pools: { ...state.pools, [String(seat)]: pool } };
}

export function addToPool(state: GameState, seat: SeatIndex, type: ManaType, amount = 1): GameState {
  return setPool(state, seat, addMana(poolOf(state, seat), type, amount));
}

/** Every permanent on the battlefield, optionally filtered. */
export function battlefield(state: GameState, predicate?: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const seat of state.seats) {
    for (const id of listAt(state, zoneKey(seat.index, 'battlefield'))) {
      if (!predicate || predicate(id)) out.push(id);
    }
  }
  return out;
}

export function creaturesControlledBy(state: GameState, seat: SeatIndex): string[] {
  return listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
    const inst = state.instances[id];
    return inst !== undefined && characteristicsOf(state, inst).isCreature;
  });
}

export const opponentsOf = (state: GameState, seat: SeatIndex): SeatIndex[] =>
  state.seats.filter((s) => s.index !== seat && !s.eliminated).map((s) => s.index);

// ── Damage and life ──────────────────────────────────────────────────────────────────────────────

/**
 * How many times one damage event may be redirected before the rest is simply prevented.
 *
 * Four, which is more than any board in this pool can build and small enough that a cycle costs
 * nothing. Two cards here redirect and each is one copy in one deck, so the realistic maximum is
 * one hop; the guard is for the board that is legal rather than the board that happens.
 */
const MAX_REDIRECTS = 4;

/**
 * Spends whatever prevention shields apply to this target against this much damage.
 *
 * Returns the damage that is **left** after they have taken what they can, and a state whose
 * shields have been decremented — or dropped, when a shield is used up. Both halves in one place
 * because they are one rule: a shield that absorbs two of three damage has to both stop the two
 * and stop being there.
 *
 * **Oldest first**, which is a simplification of CR 616.1: the player being dealt the damage
 * chooses which applicable prevention effect to apply. The choice only matters when two shields
 * cover the same target at the same time and one of them would be wasted, and the only way this
 * pool produces that is two Samite Healers tapping in the same combat — where the order changes
 * nothing, because both shields prevent the same thing. Asking would be a new prompt mid-damage
 * for a choice that has no consequence here, so it is ordered and written down instead.
 */
function spendShields(
  state: GameState, target: Target, amount: number, onlyRedirects = false,
): {
  readonly state: GameState;
  readonly amount: number;
  /** Where the points a redirecting shield took are to be dealt instead. See `redirectTo`. */
  readonly redirects: readonly { readonly to: Target; readonly amount: number }[];
} {
  let left = amount;
  let changed = false;
  const kept: ContinuousEffect[] = [];
  const redirects: { to: Target; amount: number }[] = [];
  for (const effect of state.effects) {
    const shield = effect.preventsDamageAmount;
    // Damage that can't be prevented (D1212) still meets a redirect, which is not a prevention.
    if (shield === undefined || shield <= 0 || left <= 0 || !shieldCovers(state, effect, target)
      || (onlyRedirects && effect.redirectTo === undefined)) {
      kept.push(effect);
      continue;
    }
    const used = Math.min(shield, left);
    left -= used;
    changed = true;
    /*
      A redirecting shield reports what it took, and the caller deals it elsewhere (CR 615.9).

      Reported rather than dealt here, because dealing damage from inside the function that spends
      shields would mean `dealDamage` calling itself through a helper and the shield list being
      rebuilt underneath the loop. The caller is the one place damage is ever marked, which is where
      a second damage event belongs.
    */
    if (effect.redirectTo !== undefined && used > 0) {
      redirects.push({ to: effect.redirectTo, amount: used });
    }
    if (shield - used > 0) kept.push({ ...effect, preventsDamageAmount: shield - used });
  }
  return { state: changed ? { ...state, effects: kept } : state, amount: left, redirects };
}

/**
 * How many points of prevention are sitting on this target.
 *
 * The read-only half of the same question `spendShields` asks, through the same `shieldCovers`, so
 * the number a player is shown and the number the damage meets can never disagree. `viewFor` is
 * what wants it: a shield is not a counter and not a keyword, so without this it is invisible.
 */
export function shieldOn(state: GameState, target: Target): number {
  let total = 0;
  for (const effect of state.effects) {
    const shield = effect.preventsDamageAmount;
    if (shield === undefined || shield <= 0) continue;
    if (shieldCovers(state, effect, target)) total += shield;
  }
  return total;
}

/**
 * Whether a shield is on this target: a permanent by id, a player by seat, or either of them for a
 * shield that covers a whole side.
 *
 * `state` is here for the side scope and only for it: "you and/or permanents you control" has to
 * ask whose permanent this is, which the effect cannot say because the scope is read live.
 */
function shieldCovers(state: GameState, effect: ContinuousEffect, target: Target): boolean {
  // An ability cannot be damaged, so it cannot be shielded either. Said here as well as in
  // `dealDamage` because this is reached from `spendShields`, and a shield that matched an ability
  // id would be spent on damage that was never going to happen.
  if (target.kind === 'ability') return false;
  if (effect.scope.kind === 'seat-side') {
    // The player, or anything they control right now. See the `seat-side` scope.
    return target.kind === 'player'
      ? effect.scope.seat === target.seat
      : state.instances[target.id]?.zoneSeat === effect.scope.seat;
  }
  if (target.kind === 'player') {
    return effect.scope.kind === 'seat' && effect.scope.seat === target.seat;
  }
  return effect.scope.kind === 'cards' && effect.scope.ids.includes(target.id);
}

/**
 * "Prevent the next N damage that would be dealt to any target this turn" (CR 615.1).
 *
 * The shield half of prevention, as opposed to `preventCombatDamage`'s blanket: a quantity that is
 * spent by the damage it absorbs, against any source rather than only combat, and able to sit on a
 * player as well as on a permanent. `dealDamage` is the only thing that reads it.
 */
/**
 * "The next time <source> would deal damage to <target> this turn, prevent that damage" (D1326): a
 * shield keyed to one source, as the object it is now. See `ContinuousEffect.nextDamageFrom`.
 */
export function preventNextDamageFrom(
  state: GameState, source: string, controller: SeatIndex, protectedTarget: Target, from: string, redirectTo?: Target,
): GameState {
  if (protectedTarget.kind === 'ability' || state.instances[from] === undefined) return state;
  return pushEffect(state, {
    source, controller,
    scope: protectedTarget.kind === 'player' ? { kind: 'seat', seat: protectedTarget.seat } : { kind: 'cards', ids: [protectedTarget.id] },
    nextDamageFrom: damageSourceRef(state, from),
    ...(redirectTo === undefined ? {} : { redirectTo }),
    duration: 'end-of-turn',
  });
}

export function preventDamage(
  state: GameState, source: string, controller: SeatIndex, target: Target, amount: number,
  /**
   * Where the absorbed points are dealt instead — redirection rather than plain prevention
   * (CR 615.9). See `ContinuousEffect.redirectTo`.
   *
   * A parameter on the same builder rather than a builder of its own, because the two are the same
   * effect: a redirect *is* a shield, and every rule about how many points it takes, what order it
   * takes them in and when it disappears is the same. The difference is one field, and a second
   * builder would have had to repeat all of that to add it.
   */
  redirectTo?: Target,
): GameState {
  if (amount <= 0) return state;
  // Nothing can be prevented on an ability: see `dealDamage`.
  if (target.kind === 'ability') return state;
  // Nor redirected *to* one: damage has nowhere to go on an ability (CR 120.3), so a redirect
  // pointed at one would silently throw the points away rather than preventing them.
  if (redirectTo?.kind === 'ability') return state;
  return pushEffect(state, {
    source,
    controller,
    scope: target.kind === 'player'
      ? { kind: 'seat', seat: target.seat }
      : { kind: 'cards', ids: [target.id] },
    preventsDamageAmount: amount,
    ...(redirectTo === undefined ? {} : { redirectTo }),
    duration: 'end-of-turn',
  });
}

/**
 * "Prevent the next N damage that would be dealt to **you and/or permanents you control** this
 * turn", with the absorbed points optionally dealt somewhere else (CR 615.1, 615.9).
 *
 * `preventDamage`'s sibling rather than a parameter on it, because the thing being protected is of
 * a different kind: that one takes a `Target` and puts the shield on it, and this takes a *seat*
 * and puts one shield over everything that seat has. One shield and not many, which is the whole
 * reason the `seat-side` scope exists: the printed cards give a single quantity for the pair, and
 * a shield per permanent would prevent that much damage several times over.
 */
export function preventDamageToSide(
  state: GameState, source: string, controller: SeatIndex, seat: SeatIndex, amount: number,
  redirectTo?: Target,
): GameState {
  if (amount <= 0) return state;
  // Nothing can be redirected onto an ability: see `preventDamage`.
  if (redirectTo?.kind === 'ability') return state;
  return pushEffect(state, {
    source,
    controller,
    scope: { kind: 'seat-side', seat },
    preventsDamageAmount: amount,
    ...(redirectTo === undefined ? {} : { redirectTo }),
    duration: 'end-of-turn',
  });
}

/**
 * Marks damage on a creature or deals it to a player.
 *
 * Damage to a creature is *marked*, not subtracted from toughness: a creature with 3 damage that is
 * then pumped to 5/5 survives, and that only works if the damage is remembered separately.
 * Deathtouch and lifelink are properties of the source, so they are passed in rather than looked up
 * — the same function serves combat damage, where the source is a creature, and a burn spell, where
 * it is not.
 */
export function dealDamage(
  state: GameState,
  target: Target,
  amount: number,
  opts: {
    readonly controller?: SeatIndex;
    /**
     * The attacking creature, when this is **combat** damage. Only combat damage from a commander
     * counts towards the twenty-one that eliminates a player (CR 903.10), so this is passed by
     * `dealCombatDamage` and by nothing else — a burn spell cast by a commander is not it, and a
     * single `source` option would have been quietly wrong for exactly that case.
     */
    readonly combatFrom?: string;
    /**
     * Combat damage to a creature (D821): `combatFrom` is only passed for damage to a player or a
     * planeswalker, because it is what makes commander damage count, so damage between an attacker
     * and its blockers says it is combat damage with this instead. Asked by the combat-only
     * prevention flag, which until now never saw a blocker's damage as combat damage.
     */
    readonly combat?: true;
    /**
     * What is dealing the damage: a permanent, or a spell on the stack whose id is its own card.
     *
     * **Required, and required on purpose.** Protection from a colour (CR 702.16) is a fact about
     * the *source*, so the only way to apply it is to know what dealt the damage — and the only
     * way to be sure twenty-one call sites all say is to make the compiler ask. `null` is the
     * honest answer for damage with no source a colour can be read from, and the rules agree with
     * it: protection is from colours, so a colourless source gets through.
     */
    readonly source: string | null;
    /**
     * How many redirects this damage has already been through. Internal, and set only by
     * `dealDamage` calling itself.
     *
     * A redirect is a new damage event (CR 615.9), so a shield on the *destination* applies to it —
     * including one that redirects again, which two Harm's Ways pointed at each other's protectees
     * would be. That is a legal board and a real loop, so the chain is bounded: past the limit the
     * points are simply prevented, which is the safe direction to be wrong in (damage that does not
     * happen rather than damage dealt twice) and is written down rather than discovered.
     */
    readonly redirectDepth?: number;
  },
): GameState {
  if (amount <= 0) return state;
  /*
    Damage has nowhere to go on an ability.

    An ability on the stack is neither a permanent nor a player, and those are the only two things
    damage can be dealt to (CR 120.3). Refused here rather than left to fall through into the
    creature branch below, which would look up `target.id` in `instances`, find nothing and return
    unchanged — the same answer by accident instead of on purpose.
  */
  if (target.kind === 'ability') return state;
  let next = state;
  // D865: doubled or tripled first, as the damage is about to be dealt, before any prevention takes
  // from it. A redirect is a new event and is not multiplied again.
  if ((opts.redirectDepth ?? 0) === 0) amount = multipliedDamage(next, target, amount, opts.controller, opts.source);
  /*
    Damage that can't be prevented (D1212): Skullcrack's turn, or Combust's own damage. Every
    prevention below is skipped — protection's included (CR 702.16e), and a shield counter's, which
    is a prevention too (CR 122.1c) — and a redirect still applies, since it is not one.
  */
  const unpreventable = next.damageUnpreventableThisTurn === true || next.damageUnpreventableNow === true
    || preventionSwitchedOff(next, opts.combatFrom !== undefined || opts.combat === true ? opts.source : null);
  // Protection from the source's colour prevents the damage entirely (CR 702.16b). Asked before
  // anything is marked, because prevention is not something that can be undone afterwards.
  if (!unpreventable && target.kind === 'card' && protectedFrom(next, target.id, opts.source)) return next;
  // And "prevent all damage that would be dealt to you" (D716, `CardScript.preventsDamageToYou`).
  if (!unpreventable && target.kind === 'player' && damageToYouPrevented(next, target.seat)) return next;
  // And a player with protection from everything (D718): damage to them is prevented.
  if (!unpreventable && target.kind === 'player' && playerProtected(next, target.seat)) return next;
  // And "If a red source would deal damage to you, prevent 2 of that damage" (D1308).
  if (!unpreventable && target.kind === 'player') {
    amount -= damageToYouReduction(next, target.seat, opts.source, opts.controller);
    if (amount <= 0) return next;
  }
  // And "prevent all damage that would be dealt to / by …" this turn (D738).
  if (!unpreventable && damagePrevented(next, target, opts.source, opts.combatFrom !== undefined || opts.combat === true)) return next;
  // The next damage from a chosen source (D1326): all of this event, prevented or sent on.
  if (!unpreventable && opts.source !== null && opts.source !== undefined) {
    const ref = damageSourceRef(next, opts.source);
    const shield = next.effects.find((effect) => effect.nextDamageFrom === ref && shieldCovers(next, effect, target));
    if (shield !== undefined) {
      next = { ...next, effects: next.effects.filter((effect) => effect !== shield) };
      if (shield.redirectTo === undefined || (opts.redirectDepth ?? 0) >= MAX_REDIRECTS) return next;
      return dealDamage(next, shield.redirectTo, amount, { ...opts, redirectDepth: (opts.redirectDepth ?? 0) + 1 });
    }
  }
  // A shield counter (D1033, CR 122.1c): the damage is replaced by removing one.
  if (!unpreventable && target.kind === 'card') {
    const shielded = spendShieldCounter(next, target.id);
    if (shielded !== null) return shielded;
  }
  // "If damage would be dealt to ~, prevent that damage. Remove a +1/+1 counter from ~" (D1147).
  if (target.kind === 'card') {
    const replaced = replaceDamageToSelf(next, target.id, amount);
    if (replaced !== null) return replaced;
  }
  /*
    Then prevention shields take what they can (CR 615.1), also before anything is marked.

    `left` rather than `amount` from here down, and every use of it matters: damage that was
    prevented is damage that was never dealt, so it does not reduce life, does not mark a creature,
    does not count towards the twenty-one a commander needs, does not mark deathtouch, and gains no
    life for a lifelink source. A shield read after the fact could not do any of that.
  */
  const shielded = spendShields(next, target, amount, unpreventable);
  next = shielded.state;
  const left = shielded.amount;
  /*
    And the points a redirecting shield took go somewhere else (CR 615.9).

    Through `dealDamage` again rather than written straight onto the destination, which is what
    makes the redirected damage a real damage event: protection on the destination stops it, infect
    on the source poisons with it, a lifelink source gains the life, and a shield there takes its
    share. `MAX_REDIRECTS` bounds the chain — see `redirectDepth`.
  */
  const depth = opts.redirectDepth ?? 0;
  for (const hop of shielded.redirects) {
    if (depth >= MAX_REDIRECTS) continue;
    next = dealDamage(next, hop.to, hop.amount, { ...opts, redirectDepth: depth + 1 });
  }
  if (left <= 0) return next;
  /*
    Infect, which changes what the damage *becomes* rather than whether it is dealt (CR 702.90b).

    A fact about the **source**, like protection and like deathtouch, so it is read off whatever
    dealt the damage — a creature on the battlefield, or a spell whose own id is its card. Read
    after the shields have taken their share, because prevented damage is damage that was never
    dealt and poison is no different from life in that regard.
  */
  const sourceKeywords = opts.source !== null && next.instances[opts.source] !== undefined
    ? characteristicsOf(next, next.instances[opts.source]!).keywords
    : null;
  const infect = sourceKeywords !== null && sourceKeywords.has('infect');
  /*
    Wither (CR 702.78a), which is infect's creature half and **only** that half (D504).

    Read here beside infect because it is the same fact about the same source, and kept as a second
    local rather than folded into the first because the two part company in the player branch below:
    infect's damage to a player is poison, wither's is life. A Boggart Ram-Gang hits you for three
    life and leaves three -1/-1 counters on whatever blocks it; collapsing the two would make it an
    infect creature, which is a different card in a format where ten poison ends the game.
  */
  const withers = sourceKeywords !== null && sourceKeywords.has('wither');
  /*
    **Deathtouch and lifelink, read off the source — like infect and wither, and unlike before.**

    These two were `opts` the caller had to pass, and of the **41 call sites of this function
    exactly one passed them**: `dealCombatDamage`, from the fighting creature's own keywords. So
    deathtouch worked in combat and nowhere else, which is not what the rules say — CR 702.2b is
    "any nonzero damage", in combat or out — and lifelink was the same (CR 702.15b). A Basilisk
    Collar on a pinger, a Prey Upon with a deathtoucher, a "deals damage equal to its power to any
    target" trigger: all of them dealt ordinary damage.

    Found by a test that asked. D542's bite reader wanted a row proving the damage comes from the
    **creature** rather than from the spell, deathtouch is the cheapest keyword that can tell, and
    the row failed: a 1/1 Typhoid Rats bit a 2/2 and the 2/2 lived.

    Read here rather than left to the callers for the reason `infect` is: it is a fact about the
    source, the source is already in hand, and a rule that forty callers have to remember is a rule
    thirty-nine of them get wrong. The two `opts` are **deleted** rather than kept as an override,
    so there is one answer and no way to disagree with it; combat's own call sites passed exactly
    what this computes, so nothing about combat changes.
  */
  const deadly = sourceKeywords !== null && sourceKeywords.has('deathtouch');
  const lifelinked = sourceKeywords !== null && sourceKeywords.has('lifelink');
  if (target.kind === 'player') {
    const seat = next.seats[target.seat];
    if (seat === undefined) return next;
    const from = opts.combatFrom === undefined ? undefined : next.instances[opts.combatFrom];
    /**
     * Keyed by the **seat whose commander it is**, not by the commander's instance id.
     *
     * The id would be closer to the rule, which is per commander object. The seat is right
     * anyway, and it is right for a reason worth stating: `commanderDamage:adjust` — the tabletop
     * action a player uses to record damage by hand — has always keyed by seat, and `viewFor`
     * ships the record straight to the client. Two key spaces in one record would mean ten damage
     * recorded by hand and eleven dealt by the engine never add up to the twenty-one that
     * eliminates, which is exactly the table a mixed game produces.
     *
     * Owner rather than controller, so a stolen commander still deals *its own* damage. The one
     * case this is wrong for is a deck with two commanders, where the rule counts each separately
     * and this would sum them; nothing in the pool has partner.
     */
    const key = from?.isCommander === true ? String(from.owner) : null;
    const tally = key === null
      ? {}
      : {
        commanderDamage: { ...seat.commanderDamage, [key]: (seat.commanderDamage[key] ?? 0) + left },
        // And per commander (D640): see `Seat.commanderDamageBy`.
        commanderDamageBy: { ...(seat.commanderDamageBy ?? {}), [from!.id]: ((seat.commanderDamageBy ?? {})[from!.id] ?? 0) + left },
      };
    /*
      And the wider tally, which is for the table rather than for the rules: all damage, by the
      seat that dealt it (`Seat.damageFrom`).

      Attributed from the most specific thing the caller passed, in this order: the attacking
      creature when this is combat, then whatever `source` is — a permanent on the battlefield
      belongs to the seat controlling it, a spell on the stack to its owner — and `controller` last,
      which is the one callers pass for lifelink and not for attribution. Damage with no source at
      all (a state-based action, a cost) is counted against nobody rather than against a guess.
    */
    const dealer = from !== undefined
      ? from.zoneSeat
      : (() => {
        const src = opts.source === null ? undefined : next.instances[opts.source];
        if (src !== undefined) return src.zone === 'battlefield' ? src.zoneSeat : src.owner;
        return opts.controller;
      })();
    const dealt = dealer === undefined
      ? {}
      : {
        damageFrom: {
          ...seat.damageFrom,
          [String(dealer)]: (seat.damageFrom[String(dealer)] ?? 0) + left,
        },
      };
    /*
      Poison instead of life, and the commander tally **still counts** (CR 702.90b, 903.10).

      The damage is dealt either way — infect replaces what being dealt it does to you, not whether
      it happened — so a commander with infect still works towards the twenty-one that eliminates a
      player while putting poison on them. Both at once is the rule rather than a generosity.
    */
    next = infect
      ? replaceSeat(next, target.seat, { poison: clampValue(seat.poison + left), ...tally, ...dealt })
      // And the turn's own record of it, which is what spectacle reads. Only on the life half:
      // poison is not life lost (CR 120.3). See `recordLifeLost`.
      // Dealt and tallied, and the life left where it is while it can't change (D733).
      : lifeLocked(next, target.seat)
        ? replaceSeat(next, target.seat, { ...tally, ...dealt })
        : recordLifeLost(
          replaceSeat(next, target.seat, { life: clampValue(seat.life - left * lifeLossMultiplier(next, target.seat)), ...tally, ...dealt }),
          target.seat, left * lifeLossMultiplier(next, target.seat),
        );
    // After both branches, because both dealt damage: poison or life is what it *did* (D558).
    next = recordDamaged(next, target.seat, left);
    // And whether it was combat damage (D1259): Tymna's count.
    if (opts.combatFrom !== undefined && left > 0) {
      next = { ...next, combatDamagedThisTurn: { ...(next.combatDamagedThisTurn ?? {}), [String(target.seat)]: true } };
    }
  } else {
    const inst = next.instances[target.id];
    if (inst === undefined || inst.zone !== 'battlefield') return next;
    /*
      Damage to a planeswalker removes that many loyalty counters (CR 120.3c) rather than being
      marked on it. Not a detail: marked damage wears off at end of turn, and a planeswalker that
      healed every turn would be unkillable by anything but a removal spell.
    */
    /*
      A planeswalker loses loyalty, infect or not — which is a **deliberate divergence**.

      The rules treat a planeswalker as a permanent for infect (CR 702.90b), so the damage would be
      `-1/-1` counters, which do nothing at all to something that is not a creature: an infect
      attacker cannot touch a planeswalker. That is the rule and it is also a strange table to
      explain, nothing in this pool makes the interaction common, and the divergence favours the
      attacker rather than quietly eating their damage. Named here rather than discovered later.
    */
    if (hasType(characteristicsOf(next, inst).typeLine, 'planeswalker')) {
      const loyalty = inst.counters['loyalty'] ?? 0;
      const counters = { ...inst.counters, loyalty: Math.max(0, loyalty - left) };
      next = withInstance(next, inst.id, { counters });
      if (lifelinked && opts.controller !== undefined) next = gainLife(next, opts.controller, left);
      return recordDamage(next, target, left, opts.source, opts.controller);
    }
    /*
      And to a creature, infect is `-1/-1` counters instead of marked damage (CR 702.90b) — as is
      **wither**, which is this half of infect and no other (CR 702.78a, D504).

      The difference is permanent: marked damage is wiped in the cleanup step and a counter is not,
      so a 3/3 that took two infect damage is a 1/1 for the rest of the game. Deathtouch still
      applies on top, because damage *was* dealt and that is all deathtouch asks (CR 702.2b).
    */
    next = infect || withers
      ? withInstance(next, inst.id, {
        counters: {
          ...inst.counters,
          '-1/-1': clampValue((inst.counters['-1/-1'] ?? 0) + left),
          ...(deadly ? { deathtouched: 1 } : {}),
        },
      })
      : withInstance(next, inst.id, {
        damage: clampValue(inst.damage + left),
        // Any damage from a deathtouch source destroys the creature (CR 702.2b). Marking it keeps
        // state-based actions the only place something actually dies.
        ...(deadly ? { counters: { ...inst.counters, deathtouched: 1 } } : {}),
      });
    /*
      And infect's and wither's counters are put on (D1300): written above rather than through
      `addCounters`, so they were never announced, and no "-1/-1 counters are put on" trigger saw
      them. Put by the source's controller (CR 702.80c).
    */
    if ((infect || withers) && left > 0 && inst.zone === 'battlefield') {
      const putter = opts.source === null ? undefined : next.instances[opts.source]?.zoneSeat;
      next = { ...next, countersPut: [...(next.countersPut ?? []), { card: inst.id, counter: '-1/-1', amount: left, ...(putter === undefined ? {} : { by: putter }) }] };
    }
  }
  if (lifelinked && opts.controller !== undefined) next = gainLife(next, opts.controller, left);
  return recordDamage(next, target, left, opts.source, opts.controller);
}

/**
 * How an object that dealt damage is remembered: its id and **which object** that id was.
 *
 * A card that leaves the battlefield and comes back is a new object (CR 400.7) with the same id,
 * so "dealt damage by ~ this turn" keyed on the id alone would credit a blinked Sengir Vampire
 * with a bite its previous self took. `objectSeq` moves on every zone change, which is the whole
 * distinction. See `AutomationState.damagedBy`.
 */
export function damageSourceRef(state: GameState, id: string): string {
  return `${id}#${state.instances[id]?.objectSeq ?? 0}`;
}

/** Whether this permanent, as the object it is now, was dealt damage this turn (D759). */
export function wasDealtDamageThisTurn(state: GameState, id: string): boolean {
  return (state.permanentsDamagedThisTurn ?? []).includes(damageSourceRef(state, id));
}

/**
 * Writes down damage that landed — `AutomationState.damageDealt` for the events `settle` raises,
 * and `damagedBy` for the turn's memory of who hit which permanent (D566).
 *
 * Called from the two places `dealDamage` finishes with damage actually dealt, and from nowhere
 * else: every early return above it is damage that did not happen (nothing left after protection
 * or a shield, a target that is not there). Only on an automated table, for the reason `died` is —
 * nothing drains the list on a tabletop.
 */
function recordDamage(
  state: GameState, target: Exclude<Target, { kind: 'ability' }>, amount: number,
  source: string | null, controller?: SeatIndex,
): GameState {
  if (!state.automated) return state;
  const sourceInPlay = source !== null && state.instances[source]?.zone === 'battlefield';
  const to = target.kind === 'player'
    ? { kind: 'player' as const, seat: target.seat }
    : { kind: 'card' as const, id: target.id };
  // What is attached to it now (D994), before any state-based action can detach it.
  const hosted = to.kind === 'card'
    ? Object.values(state.instances).filter((inst) => inst.zone === 'battlefield' && inst.attachedTo === to.id).map((inst) => inst.id)
    : [];
  // And on the source (D844), for "equipped creature deals combat damage" when it dies of it.
  const sourceHosted = source === null || !sourceInPlay
    ? []
    : Object.values(state.instances).filter((inst) => inst.zone === 'battlefield' && inst.attachedTo === source).map((inst) => inst.id);
  let next: GameState = {
    ...state,
    damageDealt: [...(state.damageDealt ?? []), {
      to, source, sourceInPlay, amount, ...(hosted.length === 0 ? {} : { hosted }),
      ...(sourceHosted.length === 0 ? {} : { sourceHosted }),
      ...(controller === undefined ? {} : { controller }),
    }],
  };
  // "Was dealt damage this turn" (D759), whatever dealt it.
  if (to.kind === 'card' && amount > 0) {
    const self = damageSourceRef(next, to.id);
    if (!(next.permanentsDamagedThisTurn ?? []).includes(self)) {
      next = { ...next, permanentsDamagedThisTurn: [...(next.permanentsDamagedThisTurn ?? []), self] };
    }
  }
  if (to.kind === 'card' && source !== null && sourceInPlay) {
    const ref = damageSourceRef(next, source);
    const before = next.damagedBy?.[to.id] ?? [];
    if (!before.includes(ref)) {
      next = { ...next, damagedBy: { ...(next.damagedBy ?? {}), [to.id]: [...before, ref] } };
    }
  }
  return next;
}

/**
 * A player **gets N poison counters** (D1022): "target opponent gets two poison counters", "each
 * opponent gets a poison counter", and the hit player's "that player gets a poison counter". Not
 * damage and not life: the same counters toxic and infect give (CR 122.1f), and ten of them lose
 * the game in the state-based check that already reads `poison`.
 */
export function givePoison(state: GameState, seat: SeatIndex, amount: number): GameState {
  const player = state.seats[seat];
  if (player === undefined) return state;
  return replaceSeat(state, seat, { poison: clampValue(player.poison + amount) });
}

export function gainLife(state: GameState, seat: SeatIndex, gained0: number): GameState {
  if (gained0 <= 0) return state;
  // "Your life total can't change" (D733): no life is gained, so nothing triggers on it.
  if (lifeLocked(state, seat)) return state;
  // "Players can't gain life this turn" (D1212, Skullcrack).
  if (state.lifeGainBlockedThisTurn?.[String(seat)] === true) return state;
  /*
    The replacements on gaining life (D1127, CR 614.1a). The gaining player orders them (CR 616.1),
    and the order that gains the most is taken: "gains no life" ends it, "loses that much life
    instead" turns it into a loss, and otherwise every "plus N" before every "twice".
  */
  const replacing = lifeGainReplacementsFor(state, seat);
  if (replacing.some((r) => r === 'none')) return state;
  if (replacing.some((r) => r === 'loss')) return loseLife(state, seat, gained0);
  let amount = gained0;
  for (const r of replacing) if (typeof r === 'object') amount += r.plus;
  for (const r of replacing) if (r === 'twice') amount *= 2;
  const s = state.seats[seat];
  if (s === undefined) return state;
  const key = String(seat);
  const gained = state.lifeGainedThisTurn ?? {};
  return {
    ...replaceSeat(state, seat, { life: clampValue(s.life + amount) }),
    // "If you gained life this turn" — see `GameState.attackedThisTurn` for the four of them.
    lifeGainedThisTurn: { ...gained, [key]: (gained[key] ?? 0) + amount },
  };
}

/**
 * The turn's facts, read for one seat (D564). A record older than D564 has none of the fields, and
 * every answer here is then "it did not happen", which is what an old save can honestly say.
 */
export const turnFacts = {
  attacked: (state: GameState, seat: SeatIndex): number =>
    state.attackedThisTurn?.[String(seat)] ?? 0,
  creaturesDied: (state: GameState): number => state.creaturesDiedThisTurn ?? 0,
  /** Creatures that died this turn under this seat's control (D764). */
  creaturesDiedUnder: (state: GameState, seat: SeatIndex): number =>
    state.creaturesDiedThisTurnBy?.[String(seat)] ?? 0,
  leftBattlefield: (state: GameState, seat: SeatIndex): number =>
    state.leftBattlefieldThisTurn?.[String(seat)] ?? 0,
  lifeGained: (state: GameState, seat: SeatIndex): number =>
    state.lifeGainedThisTurn?.[String(seat)] ?? 0,
  /** Permanent cards put into this seat's graveyard this turn (D612). */
  descended: (state: GameState, seat: SeatIndex): number =>
    state.descendedThisTurn?.[String(seat)] ?? 0,
  /** Tokens this seat created this turn (D1084). */
  tokensCreated: (state: GameState, seat: SeatIndex): number =>
    state.tokensCreatedThisTurn?.[String(seat)] ?? 0,
} as const;

/**
 * The key `Seat.counters` keeps energy under. One constant, because three files spell it.
 *
 * `Seat.counters` has always been "arbitrary named counters (energy, experience, rad, tickets)"
 * and nothing had used it; energy is the first, and naming the key here is what stops the second
 * user inventing `'Energy'` and quietly starting a separate pile.
 */
export const ENERGY = 'energy';

/** How much energy a seat has (CR 122.1). Zero for a seat that has never been given any. */
export function energyOf(state: GameState, seat: SeatIndex): number {
  return state.seats[seat]?.counters[ENERGY] ?? 0;
}

/**
 * "You get {E}{E}" — energy counters given to a player (CR 122.2).
 *
 * One function for both directions, with `spendEnergy` below as the named mirror, for the reason
 * `recordLifeLost` is one function: a resource whose arithmetic is written out at each call site
 * is one that eventually goes negative somewhere. The floor at zero is the rule rather than
 * defensive programming — you cannot pay energy you do not have, and the cost paths refuse before
 * they get here — but a floor that cannot be reached costs nothing and a missing one is a seat
 * with minus three energy.
 *
 * Energy is **not** emptied at end of turn, which is the whole character of the resource and is
 * why nothing in `endTurnCleanup` touches it. The absence is deliberate enough to say out loud.
 */
export function addEnergy(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount === 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  const next = Math.max(0, clampValue((s.counters[ENERGY] ?? 0) + amount));
  const counters: Record<string, number> = { ...s.counters };
  if (next === 0) delete counters[ENERGY];
  else counters[ENERGY] = next;
  return replaceSeat(state, seat, { counters });
}

/**
 * A player's other named counters (D1263): experience (CR 122.1), and any kind a card names. Energy
 * has its own pair above because three files spell its key; this is the same arithmetic for the rest.
 */
export function addSeatCounters(state: GameState, seat: SeatIndex, kind: string, amount: number): GameState {
  if (amount === 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  const next = Math.max(0, clampValue((s.counters[kind] ?? 0) + amount));
  const counters: Record<string, number> = { ...s.counters };
  if (next === 0) delete counters[kind];
  else counters[kind] = next;
  return replaceSeat(state, seat, { counters });
}

/** "Pay {E}{E}" — the same arithmetic the other way, named for what a card says. */
export function spendEnergy(state: GameState, seat: SeatIndex, amount: number): GameState {
  return addEnergy(state, seat, -amount);
}

export function loseLife(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  if (lifeLocked(state, seat)) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  const lost = amount * lifeLossMultiplier(state, seat);
  return recordLifeLost(replaceSeat(state, seat, { life: clampValue(s.life - lost) }), seat, lost);
}

/**
 * "If an opponent would lose life during your turn, they lose twice that much life instead" (D868,
 * Bloodletter of Aclazotz): two for each such permanent the active player controls, face up and with
 * its abilities, when `seat` is that player's opponent. Damage to a player is life lost too, so
 * `dealDamage` asks it as well; the damage itself (lifelink, the commander tally) is not doubled.
 */
export function lifeLossMultiplier(state: GameState, seat: SeatIndex): number {
  if (scriptLookup === null || state.activeSeat === seat) return 1;
  const lookup = scriptLookup;
  let times = 1;
  for (const id of listAt(state, zoneKey(state.activeSeat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
    if (lookup(state.cardDefs[inst.defKey])?.opponentsLoseDoubleOnYourTurn === true) times *= 2;
  }
  return times;
}

/**
 * Remembers that a seat lost life **this turn** (CR 702.137a).
 *
 * One function called from the two places a seat's life goes down — this file's `dealDamage` to a
 * player and `loseLife` above — for the reason `relocate` records every zone change in one place:
 * a fact recorded at each call site is a fact some call site forgets. Spectacle is what reads it,
 * and `endTurnCleanup` is what clears it.
 *
 * Damage that was replaced by poison does not come through here, which is the rule rather than an
 * oversight: infect replaces what being dealt damage *does* to you, and what it does is not lose
 * you life (CR 120.3). An infect deck's hits do not turn on a spectacle cost.
 */
/**
 * Remembers that a seat was **dealt damage** this turn — see `GameState.damagedThisTurn` for why
 * this is not `recordLifeLost` and must not become it.
 */
function recordDamaged(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const key = String(seat);
  const before = state.damagedThisTurn ?? {};
  return { ...state, damagedThisTurn: { ...before, [key]: (before[key] ?? 0) + amount } };
}

/** How much damage this seat has been dealt this turn. Zero for a record older than D558. */
export function damagedThisTurn(state: GameState, seat: SeatIndex): number {
  return state.damagedThisTurn?.[String(seat)] ?? 0;
}

export function recordLifeLost(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const key = String(seat);
  return {
    ...state,
    lifeLostThisTurn: {
      ...state.lifeLostThisTurn,
      [key]: (state.lifeLostThisTurn[key] ?? 0) + amount,
    },
  };
}

// ── Moving cards ─────────────────────────────────────────────────────────────────────────────────

/** Destroys a permanent: to its owner's graveyard, unless it is indestructible. */
/** The counter a regeneration shield is kept as, so it travels with the permanent and the state. */
export const REGENERATION = 'regeneration';

/**
 * The marker an unearthed permanent carries, so its own death can be replaced (CR 702.84a).
 *
 * Unearth's second half is "exile it … or if it would leave the battlefield", which only applies to
 * the body the ability put there: a Hellspark Elemental that was **cast** and dies goes to the
 * graveyard like anything else, and can be unearthed from there. So the difference is a fact about
 * the instance rather than about the card, and it is kept the way regeneration's shield is — a
 * counter, which is already per-permanent, serialised and visible.
 *
 * Read off `vanished` rather than off the instance when the death is being replaced: counters are
 * taken off a card on its way out of the battlefield, so by then the snapshot is the only place the
 * answer survives (the same read a Hangarback Walker's death trigger makes).
 */
export const UNEARTHED = 'unearthed';
/**
 * "If it would leave the battlefield, exile it instead of putting it anywhere else" (D859, Whip of
 * Erebos): a marker on the permanent, read by `replaceZoneChange` off the `vanished` snapshot, so it
 * holds however the permanent leaves and whatever became of the card that put it there.
 */
export const EXILED_ON_LEAVING = 'exiled-on-leaving';

/**
 * The marker an **evoked** permanent carries, so its own sacrifice trigger can read it
 * (CR 702.74a).
 *
 * "If its evoke cost was paid" is an intervening-if clause about how this body got here, and the
 * card itself cannot tell: a Mulldrifter on the battlefield is a Mulldrifter, whether it was cast
 * for {4}{U}, cast for {2}{U}, reanimated or made as a copy. The stack object knew, and the stack
 * object is gone by the time the trigger resolves — so the fact is written onto the permanent as
 * it arrives, the way unearth's is, and for the same three reasons: a counter is already
 * per-permanent, already serialised and already visible on the card.
 *
 * It travels no further than this body. A creature that evoked, died and was reanimated is a new
 * object with no counters, so it stays — which is exactly what the rules say, and is the reason
 * the fact cannot live on the card's script.
 */
export const EVOKED = 'evoked';

/**
 * The marker a **dashed** permanent carries (CR 702.109a).
 *
 * `EVOKED`'s mirror and kept for a different reason. Evoke's counter is read by a trigger printed
 * on the card; this one is read by nothing in the rules — the haste and the return are both
 * arranged as the creature arrives, by the engine, and neither needs to ask afterwards. What it is
 * for is the table and the next reader: a 3/1 that is about to vanish at the end step looks exactly
 * like a 3/1 that is staying, and a game state that does not say which is a game state nobody can
 * debug. It is also what a card wanting "if its dash cost was paid" would read, the day one is
 * printed here.
 */
export const DASHED = 'dashed';

/**
 * The marker a **kicked** permanent carries (CR 702.32, D561).
 *
 * Evoke's arrangement for evoke's reason: "when this enters, if it was kicked" is a triggered
 * ability that resolves from the battlefield, after the stack object that knew how the spell was
 * paid for has gone. Written as the kicked spell resolves and read by that trigger's
 * intervening-if. Like every counter it goes when the permanent leaves, so a kicked creature that
 * is blinked comes back unkicked — which is the rule: the new object was never cast.
 */
export const KICKED = 'kicked';

/** How many times a squad cost was paid (D924), recorded as the permanent arrives. See `CardScript.squad`. */
export const SQUADDED = 'squad';

/** A permanent cast for its surge cost (D928), recorded as it arrives. See `CardScript.spectacle.surge`. */
export const SURGED = 'surged';

/**
 * A permanent cast with escape (D1370), for the Theros titans' "When ~ enters, sacrifice it unless it
 * escaped". The stack object knows (`StackObject.escaped`); this is what the permanent remembers.
 */
export const ESCAPED = 'escaped';

/** Tribute paid (D1374), for "When ~ enters, if tribute wasn't paid, …". See `CardScript.tribute`. */
export const TRIBUTED = 'tributed';
/** The answer that pays a tribute (D1374). */
export const TRIBUTE_PAID = 'Pay the tribute';
export const TRIBUTE_DECLINED = 'Decline';

/** A permanent cast for its blitz cost (D933), for its dies draw. See `CardScript.dash.blitz`. */
export const BLITZED = 'blitzed';

/**
 * The marker on a **myriad** token, which is the thing that remembers to exile it (CR 702.111a).
 *
 * "Exile those tokens at end of combat" is a delayed consequence with no card to own it: myriad can
 * be *granted* — Blade of Selves hands it to whatever it is attached to — so there is no script to
 * hang a delayed trigger on, and the Equipment coming off mid-combat must not strand the tokens on
 * the battlefield forever.
 *
 * So the token carries the instruction rather than anything else holding a list of it. That is the
 * same move `DASHED` makes and it buys the same two things: the end-of-combat step has one question
 * to ask of the board ("which permanents are marked?") rather than a register to keep in step with
 * reality, and a game state loaded out of Redis mid-combat still knows which bodies are borrowed.
 *
 * Exiled rather than sacrificed, which is what the keyword says and is not the same thing: nothing
 * sees these die, so a Blood Artist drains for nothing and the Ravager gets no counter.
 */
export const MYRIAD = 'myriad';

/**
 * The counters a **suspended** card waits on, in exile (CR 702.62b).
 *
 * The one counter in this engine that is not on a permanent, and the reason that works at all is
 * that counters have always been a field on the *instance* rather than a thing about the
 * battlefield. So a card in exile can carry three of these, the upkeep can take one off, and the
 * table can draw the number — which is the whole of what the mechanic needs to be legible: a
 * suspended card is public information and counting the turns to it is both players' business.
 */
export const TIME = 'time';

/**
 * The counter a **fading** permanent spends, one per upkeep, until there are none left
 * (CR 702.32a).
 *
 * Its own kind rather than a time counter, because the two keywords are not the same mechanic and
 * a card that reads both would be ambiguous — and because the printed line says "fade counter",
 * which is what the table draws. Vanishing's clock is `TIME`, shared with suspend, where the
 * sharing is harmless: a suspended card is in exile and a vanishing permanent is on the
 * battlefield, so no object ever carries both for two reasons.
 *
 * The off-by-one between the keywords lives in the triggers, not here. See `vanishingTrigger` and
 * `fadingTrigger`.
 */
export const FADE = 'fade';

/**
 * The marker a **renowned** creature carries (CR 702.112a).
 *
 * "If it isn't renowned" is an intervening-if about a state the creature holds, and the engine's
 * answer to any such state is a counter: already per-permanent, already serialised to Redis,
 * already visible on the card. A creature that leaves and comes back is a new object with no
 * counters, so renown is available again — which is exactly what the rules say.
 */
export const RENOWNED = 'renowned';
/**
 * Monstrous (D992, CR 701.32b): a designation, kept as a marker counter as `RENOWNED` is. Set by
 * monstrosity alongside its +1/+1 counters, so a creature that later loses those counters is still
 * monstrous, and recorded as counters put on it so "When ~ becomes monstrous" can trigger.
 */
export const MONSTROUS = 'monstrous';

/**
 * The keys in `counters` that are **markers**, not counters (D638): facts the engine keeps on the
 * permanent — a regeneration shield, "this was kicked", "this is renowned" — because that is where
 * it keeps per-object facts, not because the card has a counter on it.
 *
 * Proliferate is the reason this list exists. It adds one of each kind of counter a permanent
 * already has (CR 701.27a), and it was adding one of each of these too: a second regeneration
 * shield, a creature that was kicked twice. And a permanent carrying only a marker was offered as a
 * thing with counters on it.
 */
// And the records D924, D928 and D933 write: squad's count, a surge and a blitz.
/**
 * Impending (D1097): the permanent's impending cost was paid. Written as it arrives, beside its
 * time counters; with at least one time counter it is not a creature (CR 702.176a).
 */
export const IMPENDED = 'impended';
/** Which kicker of a double kicker was paid (D1099): "if it was kicked with its {B} kicker". */
export const KICKED_FIRST = 'kicked-first';
export const KICKED_SECOND = 'kicked-second';
export const MARKERS: ReadonlySet<string> = new Set([REGENERATION, UNEARTHED, EXILED_ON_LEAVING, EVOKED, DASHED, KICKED, MYRIAD, RENOWNED, SQUADDED, SURGED, BLITZED, MONSTROUS, IMPENDED, KICKED_FIRST, KICKED_SECOND, ESCAPED, TRIBUTED]);
registerCounterMarkers(MARKERS);

/**
 * "The next time this creature would be destroyed this turn, instead..." (CR 701.15).
 *
 * A shield, not a trigger: it sits on the permanent and is spent the next time something would
 * destroy it. Kept as a counter because that is already a per-permanent, serialised, visible
 * number — a player can see how many shields a creature has, which is exactly right.
 */
export function regenerate(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  return addCounters(state, id, REGENERATION, 1);
}

/**
 * Spends a regeneration shield, if there is one, instead of letting the creature be destroyed.
 *
 * The replacement is specific and all three parts matter: it is **tapped**, its damage is
 * **removed**, and it is **taken out of combat** — so a regenerated attacker deals no more damage
 * this turn, which is most of what makes regeneration a cost rather than a free save. Returns
 * `null` when there was no shield, so each caller can carry on with the destruction it meant.
 */
export function spendRegeneration(state: GameState, id: string): GameState | null {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return null;
  const shields = inst.counters[REGENERATION] ?? 0;
  if (shields <= 0) return null;
  const counters = { ...inst.counters };
  if (shields > 1) counters[REGENERATION] = shields - 1;
  else delete counters[REGENERATION];
  // Any lethal damage marked on it goes too, or the state-based actions would simply kill it again
  // on the next pass and the shield would have bought nothing.
  const next = withInstance(state, id, { tapped: true, damage: 0, counters });
  return removeFromCombat(next, id);
}

/**
 * Umbra armor (D947, CR 702.89a): the destruction of a creature replaced by the destruction of an
 * Aura on it with the keyword, and all damage removed from the creature. Null when no such Aura is
 * attached. The first one attached is spent; with two the creature's controller would choose, and
 * either answer leaves the same board but for which Aura is left.
 */
export function spendUmbraArmor(state: GameState, id: string): GameState | null {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return null;
  const armour = Object.values(state.instances).find((aura) => aura.zone === 'battlefield' && aura.attachedTo === id
    && scriptOfCard(state.cardDefs[aura.defKey])?.umbraArmor === true);
  if (armour === undefined) return null;
  const counters = { ...inst.counters };
  delete counters['deathtouched'];
  const healed = withInstance(state, id, { damage: 0, counters });
  // "Destroy this Aura": destroyed, so an indestructible one stays and the replacement still happens.
  return destroy(healed, armour.id);
}

/**
 * Takes one creature out of combat: it stops attacking, and stops blocking whatever it blocked.
 *
 * An attack with no attacker left is dropped entirely; a blocker is lifted off every attack it
 * was assigned to. Nothing else in combat changes, which is the point — the other attackers are
 * still attacking and the other blockers are still blocking.
 */
export function removeFromCombat(state: GameState, id: string): GameState {
  const attacks = state.combat.attacks
    .filter((attack) => attack.attacker !== id)
    .map((attack) => (attack.blockers.includes(id)
      ? { ...attack, blockers: attack.blockers.filter((b) => b !== id) }
      : attack));
  const same = attacks.length === state.combat.attacks.length
    && attacks.every((attack, i) => attack === state.combat.attacks[i]);
  return same ? state : { ...state, combat: { ...state.combat, attacks } };
}

/**
 * Puts a card onto the battlefield **tapped and attacking** (CR 702.49a, CR 506.3c).
 *
 * The first thing in this engine that adds an attacker to a combat already in progress, and the
 * rules are emphatic about what that is *not*: the creature was never declared as an attacker, so
 * nothing that triggers on attacking triggers, and no attack cost is paid. The engine gets that for
 * free — `attacks` is appended to directly rather than going through the declaration path, and the
 * declaration path is where `raise('attacks')` lives.
 *
 * Tapped, because the card says so and because an untapped creature that had not attacked would be
 * able to block on the way back round. `attackerSeq` is recorded like any declared attacker's, so
 * the damage step can tell this object from a later one with the same id.
 */
export function enterAttacking(
  state: GameState, id: string, seat: SeatIndex,
  attack: { readonly defender: SeatIndex; readonly planeswalker?: string },
): GameState {
  const placed = putOntoBattlefield(state, id, seat, { tapped: true });
  const inst = placed.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return placed;
  return {
    ...placed,
    combat: {
      ...placed.combat,
      attacks: [...placed.combat.attacks, {
        attacker: id,
        defender: attack.defender,
        ...(attack.planeswalker === undefined ? {} : { planeswalker: attack.planeswalker }),
        blockers: [],
        ...(inst.objectSeq === undefined ? {} : { attackerSeq: inst.objectSeq }),
      }],
    },
  };
}

/**
 * A shield counter (D1033, CR 122.1c): "If a permanent with a shield counter on it would be dealt
 * damage or destroyed, instead remove a shield counter from it." The replacement, for `dealDamage`,
 * `destroy` and the lethal-damage check: `null` when there is no shield counter to spend.
 */
export function spendShieldCounter(state: GameState, id: string): GameState | null {
  const inst = state.instances[id];
  // Both callers ask only about a permanent on the battlefield.
  if (inst === undefined || (inst.counters['shield'] ?? 0) <= 0) return null;
  return addCounters(state, id, 'shield', -1);
}

export function destroy(
  state: GameState, id: string,
  opts: { readonly regenerates?: boolean } = {},
): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  if (characteristicsOf(state, inst).keywords.has('indestructible')) return state;
  // A shield counter first (D1033), which "can't be regenerated" does not stop either.
  const shielded = spendShieldCounter(state, id);
  if (shielded !== null) return shielded;
  /*
    Regeneration replaces the destruction rather than following it, so it is checked here — the one
    place a card is destroyed on purpose — and again where lethal damage is noticed.

    `regenerates: false` is "It can't be regenerated" (CR 701.15, D535), and it is a parameter rather
    than a strip of the shield beforehand **because the indestructible line above it returns**. A
    creature that cannot be destroyed keeps the shield it had; removing the counters first and then
    finding the destruction does nothing would take a shield off a creature the card never touched.
  */
  if (opts.regenerates !== false) {
    const saved = spendRegeneration(state, id);
    if (saved !== null) return saved;
  }
  // Umbra armor (D947), which "can't be regenerated" does not stop.
  const wrapped = spendUmbraArmor(state, id);
  if (wrapped !== null) return wrapped;
  return relocate(state, inst, 'graveyard', inst.owner, 'bottom');
}

/**
 * The card-script lookup, handed in by `derive.ts` as it loads (D688). Importing it here would close
 * an import cycle that leaves `scripts.ts` reading constants before they exist; the one reader that
 * needs it is `protectedFromCounters`, which runs long after every module has loaded.
 */
let scriptLookup: ((def: CardDef | undefined) => CardScript | undefined) | null = null;
export function useScriptLookup(lookup: (def: CardDef | undefined) => CardScript | undefined): void {
  scriptLookup = lookup;
}

/** The script a card plays by, through the same lookup (D689); undefined before derive.ts loads. */
export function scriptOfCard(def: CardDef | undefined): CardScript | undefined {
  return scriptLookup === null ? undefined : scriptLookup(def);
}

/**
 * Whether a permanent on the battlefield says this spell can't be countered (D688): "Creature
 * spells you control can't be countered" (Rhythm of the Wild) and its kin. "You control" is the
 * permanent's controller and the spell's; the spell's kind is its card's printed type line, which is
 * what a spell on the stack has (CR 112.1). A permanent that has lost its abilities says nothing.
 */
/**
 * Whether a player's life total can't change right now (D733): Teferi's Protection's effect, or a
 * permanent of theirs with `CardScript.lifeTotalCantChange` (Platinum Emperion).
 */
/**
 * "Damage can't be prevented." printed on a permanent (D3012, `CardScript.damageUnpreventable`):
 * Leyline of Punishment, Sunspine Lynx. Every seat's battlefield, since it says all damage.
 */
function preventionSwitchedOff(
  state: GameState,
  /** The creature dealing **combat** damage, or null for any other damage (D1388). */
  combatSource: string | null = null,
): boolean {
  if (scriptLookup === null) return false;
  const lookup = scriptLookup;
  // Questing Beast's kind (D1388): only a creature its controller controls, dealing combat damage.
  const dealer = combatSource === null ? undefined : state.instances[combatSource];
  const dealerIsCreature = dealer !== undefined && dealer.zone === 'battlefield' && characteristicsOf(state, dealer).isCreature;
  return state.seats.some((row) => !row.eliminated && listAt(state, zoneKey(row.index, 'battlefield')).some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
    const kind = lookup(state.cardDefs[inst.defKey])?.damageUnpreventable;
    if (kind === true) return true;
    return kind === 'combat-by-your-creatures' && dealerIsCreature && dealer!.zoneSeat === inst.zoneSeat;
  }));
}

export function lifeLocked(state: GameState, seat: SeatIndex): boolean {
  if (state.effects.some((e) => e.lifeLocked === true && e.scope.kind === 'seat' && e.scope.seat === seat)) return true;
  if (scriptLookup === null) return false;
  const lookup = scriptLookup;
  return [...listAt(state, zoneKey(seat, 'battlefield')), ...emblemsOf(state, seat)].some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
    return lookup(state.cardDefs[inst.defKey])?.lifeTotalCantChange === true;
  });
}

/**
 * The damage after every multiplier its source's controller has (D865, `CardScript.damageMultiplier`).
 * The controller is the one passed, else the source permanent's. A multiplier scoped to opponents
 * applies only to an opponent of that controller, or to a permanent one of them controls.
 */
function multipliedDamage(state: GameState, target: Target, amount: number, controller: SeatIndex | undefined, source: string | null): number {
  if (scriptLookup === null || target.kind === 'ability') return amount;
  const seat = controller ?? (source === null ? undefined : state.instances[source]?.zoneSeat);
  if (seat === undefined) return amount;
  const lookup = scriptLookup;
  const victim = target.kind === 'player' ? target.seat : state.instances[target.id]?.zoneSeat;
  const sourceInst = source === null ? undefined : state.instances[source];
  const sourceColours = sourceInst === undefined ? [] : characteristicsOf(state, sourceInst).colors;
  let total = amount;
  let added = 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
    const rule = lookup(state.cardDefs[inst.defKey])?.damageMultiplier;
    if (rule === undefined) continue;
    if (rule.opponents === true && (victim === undefined || victim === seat)) continue;
    if (rule.colour !== undefined && !sourceColours.includes(rule.colour)) continue;
    if (rule.creatures === true && (sourceInst === undefined || sourceInst.zone !== 'battlefield' || !characteristicsOf(state, sourceInst).isCreature)) continue;
    total *= rule.factor;
    added += rule.plus ?? 0;
  }
  // The additions after the factors, the order that gives the controller the most (CR 616.1).
  return total + added;
}

/** See `CardScript.cantLose` (D3009): a permanent of the seat's, face up and with its abilities, that says so. */
export function cantLoseTheGame(state: GameState, seat: SeatIndex): boolean {
  if (scriptLookup === null) return false;
  const lookup = scriptLookup;
  // And an emblem's (D1391), which is in the command zone rather than on the battlefield.
  return [...listAt(state, zoneKey(seat, 'battlefield')), ...emblemsOf(state, seat)].some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
    const rule = lookup(state.cardDefs[inst.defKey])?.cantLose;
    return rule === true || (rule !== undefined && rule.while(state, seat));
  });
}

/** See `CardScript.winsOnEmptyDraw` (D852): a permanent of the seat's that wins it the game instead. */
function winsOnEmptyDraw(state: GameState, seat: SeatIndex): boolean {
  if (scriptLookup === null) return false;
  const lookup = scriptLookup;
  return listAt(state, zoneKey(seat, 'battlefield')).some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
    return lookup(state.cardDefs[inst.defKey])?.winsOnEmptyDraw === true;
  });
}

/** Every life-gain replacement that applies to this seat gaining life now (D1127). */
function lifeGainReplacementsFor(
  state: GameState, seat: SeatIndex,
): NonNullable<CardScript['lifeGainReplacement']>['becomes'][] {
  if (scriptLookup === null) return [];
  const lookup = scriptLookup;
  const out: NonNullable<CardScript['lifeGainReplacement']>['becomes'][] = [];
  for (const row of state.seats) {
    if (row.eliminated) continue;
    for (const id of [...listAt(state, zoneKey(row.index, 'battlefield')), ...emblemsOf(state, row.index)]) {
      const inst = state.instances[id];
      if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
      const r = lookup(state.cardDefs[inst.defKey])?.lifeGainReplacement;
      if (r === undefined) continue;
      const mine = row.index === seat;
      if (r.whose === 'you' ? mine : r.whose === 'opponents' ? !mine : true) out.push(r.becomes);
    }
  }
  return out;
}

/**
 * Whether a player has hexproof or shroud from a permanent of theirs (D1126): `controllerHas`.
 * Shroud wins over hexproof, being the wider. A permanent that has lost its abilities says nothing.
 */
export function playerShieldOf(state: GameState, seat: SeatIndex): 'hexproof' | 'shroud' | null {
  if (scriptLookup === null) return null;
  const lookup = scriptLookup;
  let shield: 'hexproof' | 'shroud' | null = null;
  for (const id of [...listAt(state, zoneKey(seat, 'battlefield')), ...emblemsOf(state, seat)]) {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
    const has = lookup(state.cardDefs[inst.defKey])?.controllerHas;
    if (has === 'shroud') return 'shroud';
    if (has === 'hexproof') shield = 'hexproof';
  }
  return shield;
}
usePlayerShield(playerShieldOf);

/**
 * Life a player could pay now (D733): none while their life total can't change (CR 119.8), else
 * any amount that leaves them alive — the line D585 draws for every life cost here.
 */
export function canPayLife(state: GameState, seat: SeatIndex, amount: number): boolean {
  if (amount <= 0) return true;
  if (lifeLocked(state, seat)) return false;
  return (state.seats[seat]?.life ?? 0) > amount;
}

/**
 * Whether the damage's source is of the kind a prevention names (D1218, `preventsDamageBy`). No
 * kind named is every source. A source the engine cannot see is not of any kind.
 */
function sourceIsOfKind(
  state: GameState, from: CardInstance | undefined, kind: ContinuousEffect['preventsDamageBy'],
): boolean {
  if (kind === undefined) return true;
  if (from === undefined) return false;
  const ch = characteristicsOf(state, from);
  if (!kind.types.every((type) => hasType(ch.typeLine, type))) return false;
  if (kind.keyword !== undefined && !ch.keywords.has(kind.keyword as never)) return false;
  if (kind.enchanted === true && !Object.values(state.instances).some((other) => other.attachedTo === from.id
    && other.zone === 'battlefield' && hasType(characteristicsOf(state, other).typeLine, 'enchantment'))) return false;
  return true;
}

/**
 * Whether a "prevent all damage" effect stops this damage (D738): one to the damaged permanent or
 * player, or one from the source. A combat-only effect lets other damage through.
 */
function damagePrevented(state: GameState, target: Target, source: string | null, combat: boolean): boolean {
  const from = source === null ? undefined : state.instances[source];
  return (state.effects ?? []).some((effect) => {
    if (effect.preventsCombatOnly === true && !combat) return false;
    if (effect.preventsNoncombatOnly === true && combat) return false;
    if (effect.preventsDamageToPlayers !== undefined && target.kind === 'player'
      && (effect.preventsDamageToPlayers === 'all' || effect.controller === target.seat)) return true;
    if (effect.preventsDamageTo === true && target.kind === 'card') {
      const inst = state.instances[target.id];
      if (inst !== undefined && inst.zone === 'battlefield' && effectReaches(state, effect, inst)
        && sourceIsOfKind(state, from, effect.preventsDamageBy)) return true;
    }
    if (effect.preventsDamageFrom === true && from !== undefined && from.zone === 'battlefield'
      && effectReaches(state, effect, from)) return true;
    return false;
  });
}

/**
 * A permanent's own replacement of damage dealt to it (D1147, `CardScript.damageToSelf`), or `null`
 * when it has none, or has one that applies only while it has a +1/+1 counter and it has none. The
 * damage is not dealt; what happens instead is the counter change. Removing a counter it does not
 * have removes none, and the damage is still prevented (the Phantoms' printed order).
 */
function replaceDamageToSelf(state: GameState, id: string, amount: number): GameState | null {
  if (scriptLookup === null) return null;
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield' || inst.faceDown || allAbilitiesLost(state, inst)) return null;
  const rule = scriptLookup(state.cardDefs[inst.defKey])?.damageToSelf;
  if (rule === undefined) return null;
  const plus = inst.counters['+1/+1'] ?? 0;
  if (rule.whileCounter === true && plus <= 0) return null;
  switch (rule.then) {
    case 'remove-one': return plus > 0 ? addCounters(state, id, '+1/+1', -1) : state;
    case 'remove-amount': return plus > 0 ? addCounters(state, id, '+1/+1', -Math.min(plus, amount)) : state;
    case 'add-plus': return addCounters(state, id, '+1/+1', amount);
    case 'add-minus': return addCounters(state, id, '-1/-1', amount);
  }
}

/**
 * How much of one damage event to `seat` their permanents prevent (D1308, `CardScript.damageToYouReduced`):
 * each Sphere whose kind the source is. The source's controller is the one passed, else the source
 * permanent's, as `multipliedDamage` reads it; its colour and type are read live.
 */
function damageToYouReduction(state: GameState, seat: SeatIndex, source: string | null, controller: SeatIndex | undefined): number {
  if (scriptLookup === null) return 0;
  const lookup = scriptLookup;
  const from = source === null ? undefined : state.instances[source];
  const by = controller ?? from?.zoneSeat;
  let total = 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
    const rule = lookup(state.cardDefs[inst.defKey])?.damageToYouReduced;
    if (rule === undefined) continue;
    if (rule.opponents === true && (by === undefined || by === seat)) continue;
    if (rule.colour !== undefined || rule.type !== undefined) {
      if (from === undefined) continue;
      const ch = characteristicsOf(state, from);
      if (rule.colour !== undefined && !ch.colors.includes(rule.colour)) continue;
      if (rule.type !== undefined && !hasType(ch.typeLine, rule.type)) continue;
    }
    total += rule.amount;
  }
  return total;
}

function damageToYouPrevented(state: GameState, seat: SeatIndex): boolean {
  if (scriptLookup === null) return false;
  const lookup = scriptLookup;
  return [...listAt(state, zoneKey(seat, 'battlefield')), ...emblemsOf(state, seat)].some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
    return lookup(state.cardDefs[inst.defKey])?.preventsDamageToYou === true;
  });
}

function protectedFromCounters(state: GameState, object: StackObject): boolean {
  if (object.kind !== 'spell' || scriptLookup === null) return false;
  const scriptForCard = scriptLookup;
  const creature = hasType(parseTypeLine(state.cardDefs[object.cardKey]?.typeLine), 'creature');
  return state.seats.some((seat) => listAt(state, zoneKey(seat.index, 'battlefield')).some((id) => {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown) return false;
    const rule = scriptForCard(state.cardDefs[inst.defKey])?.spellsCantBeCountered;
    if (rule === undefined || allAbilitiesLost(state, inst)) return false;
    if (rule.whose === 'you' && seat.index !== object.controller) return false;
    if (rule.types !== undefined) {
      const line = parseTypeLine(state.cardDefs[object.cardKey]?.typeLine);
      return rule.types.some((type) => hasType(line, type));
    }
    return rule.kind === undefined || (rule.kind === 'creature') === creature;
  }));
}

/**
 * Where a spell card goes as it leaves the stack: its owner's graveyard, or exile.
 *
 * One function for the three places a spell leaves the stack — it resolved, its targets are gone,
 * or something countered it — because flashback's second half applies to all three: "exile it
 * instead of putting it anywhere else" (CR 702.33a). Three call sites each deciding for themselves
 * is three chances for a card cast from the graveyard to end up back in the graveyard, which is a
 * one-mana spell with no end.
 */
export function spellLeavesStack(
  state: GameState, object: StackObject, inst: CardInstance, resolved = false,
): GameState {
  /*
    And an adventure that *resolved* goes to exile instead, with a flag saying it is on one.

    The second half of the mechanic, and the reason `resolved` is a parameter rather than something
    read off the object: an adventure that is **countered**, or one whose target disappeared, never
    went on an adventure at all, so its card goes to the graveyard like any other countered spell.
    All three cases arrive through this function and only the caller knows which it is — so the
    caller says, and the default is the safe half.
  */
  if (object.adventure === true && resolved) {
    const exiled = relocate(state, inst, 'exile', inst.owner, 'bottom');
    return withInstance(exiled, inst.id, { onAdventure: true });
  }
  /*
    And a spell whose **buyback** was paid goes back to its owner's hand (CR 702.26a).

    The same `resolved` test and for the same reason as the adventure above it: the promise is
    about the spell finishing, so a countered buyback spell goes to the graveyard like any other
    countered spell, and the only thing that knows which happened is the caller.

    Below the adventure branch rather than above it because no card has both and the adventure's is
    the narrower claim; above the flashback line because a flashback casting replaces the printed
    cost that buyback is paid on top of, so no casting is ever both.
  */
  if (object.boughtBack === true && resolved) {
    return relocate(state, inst, 'hand', inst.owner, 'bottom');
  }
  /*
    And an omen that resolved (D979): "Then shuffle this card into its owner's library." The
    adventure's `resolved` test, for its reason — a countered omen goes to the graveyard — and
    under flashback's exile, which replaces anywhere else the card would go (CR 702.33a).
  */
  if (object.omen === true && resolved && object.flashback !== true) {
    return shuffleLibrary(relocate(state, inst, 'library', inst.owner, 'top'), inst.owner);
  }
  // And Kess's exile (D1289), the same replacement for a spell cast under its permission.
  return relocate(state, inst, object.flashback === true || object.yardExile === true ? 'exile' : 'graveyard', inst.owner, 'bottom');
}

export function exileCard(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'exile', inst.owner, 'bottom');
}

/**
 * Exiles a card and records which permanent did it, so that permanent can give it back.
 *
 * "Exile until ~ leaves the battlefield" is one effect with two halves (CR 400.7e), and the link
 * between them is the only reason the card is fair. Kept on the exiled card — see
 * `CardInstance.exiledBy` — and read by `returnExiledBy` when the exiler leaves.
 */
export function exileUntilLeaves(state: GameState, id: string, exiledBy: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const next = relocate(state, inst, 'exile', inst.owner, 'bottom');
  // After the move, because `relocate` rebuilds the instance and would drop a field set before it.
  return next.instances[id] === undefined ? next : withInstance(next, id, { exiledBy });
}

/**
 * Returns everything a permanent exiled, to the battlefield, under its **owner's** control.
 *
 * Its owner and not the exiler's: a Banisher Priest that dies gives the creature back to the
 * player it took it from, and getting that wrong would make the card a Mind Control with extra
 * steps. A card that has since left exile — exiled again by something else, or shuffled away — is
 * skipped rather than dragged back from wherever it is now.
 */
export function returnExiledBy(
  state: GameState, exiledBy: string,
  /** Where it goes back to: the battlefield, or its owner's hand (D1009, Tidehollow Sculler). */
  to: 'battlefield' | 'hand' = 'battlefield',
): GameState {
  let next = state;
  for (const [id, inst] of Object.entries(state.instances)) {
    if (inst.exiledBy !== exiledBy) continue;
    if (inst.zone !== 'exile') continue;
    next = withInstance(next, id, { exiledBy: undefined });
    const current = next.instances[id];
    if (current === undefined) continue;
    next = relocate(next, current, to, current.owner, 'bottom');
  }
  return next;
}

export function bounceToHand(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'hand', inst.owner, 'bottom');
}

/**
 * `bounceToHand`'s sibling, one zone further back: on **top** of its owner's library (D546).
 *
 * Its own function rather than an option on the bounce, because the zone is the whole difference
 * between the two cards. A Man-o'-War's bounce gives the creature straight back and costs its
 * controller a turn of mana; an Excommunicate costs them their next draw as well, and leaves the
 * creature where an opponent who mills them can take it away. Same two lines, different card.
 *
 * `'top'` is the printed word, and the position is the point: on the bottom it would be a worse
 * Oblivion Ring and would not stop the next draw.
 */
export function putOnTopOfLibrary(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'library', inst.owner, 'top');
}

/**
 * The bottom of its owner's library, one card at a time (D954) — "put a card from your hand on the
 * bottom of your library". The sibling of `putOnTopOfLibrary`; a pile the player orders is this
 * called once per card in the order picked, and `bottomPile` is the one for a random order.
 */
export function putOnBottomOfLibrary(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'library', inst.owner, 'bottom');
}

export function putOntoBattlefield(
  state: GameState, id: string, seat: SeatIndex, opts: { readonly tapped?: boolean } = {},
): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const next = relocate(state, inst, 'battlefield', seat, 'bottom');
  return opts.tapped === true ? withInstance(next, id, { tapped: true }) : next;
}

/**
 * The mana value of a spell on the stack, which is the one place {X} is not nought (CR 202.3b).
 *
 * Everywhere else in the game X is zero — a Hurricane in a hand or a graveyard has mana value one
 * — and on the stack it is the number its controller chose, counted once per {X} symbol. So a
 * Chalice of the Void set to two counters a Divination and an Explore cast for X=1, and does not
 * counter the Endless One cast for X=5 that is sitting next to them.
 *
 * Read off the printed cost and the chosen X rather than off `CardDef.cmc`, because that field is
 * the printed mana value and cannot know about either.
 */
export function manaValueOnStack(state: GameState, id: string): number {
  const object = state.stackObjects[id];
  if (object === undefined) return 0;
  const cost = parseManaCost(state.cardDefs[object.cardKey]?.manaCost);
  return costValue(cost) + Math.max(0, object.x ?? 0) * xMultiplier(cost);
}

/**
 * Counters a spell on the stack: it is removed and put into its owner's graveyard (CR 701.5a).
 *
 * The stack is reached directly rather than through `automation.ts`, which imports this module —
 * a spell waiting to resolve is just two fields on the state, and routing through the engine would
 * only buy a cycle. An ability has no card, so countering one simply removes it.
 */
export function counterSpell(
  state: GameState,
  id: string,
  /*
    **An option the caller must pass, and here that is right** — which is worth saying because D542
    deleted two options from `dealDamage` for being exactly the wrong shape. The difference is where
    the fact lives: deathtouch is a characteristic of the damage's *source*, so a caller passing it
    was a second place for an answer the game already held. Whether a countered spell is exiled is a
    fact about the **countering card's printed text** and about nothing else on the table — there is
    nothing here to read it off.
  */
  opts: { readonly exile?: boolean; readonly to?: 'hand' | 'library-top' } = {},
): GameState {
  const object = state.stackObjects[id];
  if (object === undefined) return state;
  /*
    "This spell can't be countered" (CR 701.5a). A "can't" beats a "does" (CR 101.2), so the spell
    stays on the stack and resolves — the counterspell itself still resolved and is still spent,
    which is the whole point of the card that printed this.

    Guarded here rather than at each caller because this is the single chokepoint: ward's unpaid
    settle, the bot, and every scripted counter go through this function.
  */
  if (object.cantBeCountered === true || protectedFromCounters(state, object)) {
    return {
      ...state,
      // The note channel the engine already uses for "something happened that produced no event":
      // `reduceAutoAction` drains it onto the message of the action that provoked it, which is the
      // counterspell's own resolution — exactly where the player is looking. No log entry is
      // written here because nothing else in this module writes one directly.
      replacements: [...state.replacements,
        `${state.cardDefs[object.cardKey]?.name ?? 'that spell'} can't be countered`],
    };
  }
  const objects = { ...state.stackObjects };
  delete objects[id];
  const next: GameState = {
    ...state,
    stackObjects: objects,
    stackOrder: state.stackOrder.filter((o) => o !== id),
    // What it was as it left (D1171), for "where X is that spell's mana value" after the counter.
    ...(object.kind === 'spell' ? {
      counteredSpellsThisTurn: {
        ...state.counteredSpellsThisTurn,
        [id]: { manaValue: manaValueOnStack(state, id), manaSpent: object.manaSpent ?? 0 },
      },
    } : {}),
  };
  const inst = next.instances[id];
  if (object.kind !== 'spell' || inst === undefined) return next;
  /*
    The rider's half (D545): straight to exile, ahead of `spellLeavesStack`, because every branch in
    that function is about where a spell goes *by default* and this is a replacement of the default.
    Flashback already exiles, so the two agree there rather than fighting; an adventure or a buyback
    spell that is countered never reached its `resolved` branch anyway.
  */
  if (opts.exile === true) return relocate(next, inst, 'exile', inst.owner, 'bottom');
  // Remand's hand and Memory Lapse's library (D1337), unless flashback exiles it (CR 702.34a).
  if (opts.to !== undefined && object.flashback !== true && object.yardExile !== true) {
    return relocate(next, inst, opts.to === 'hand' ? 'hand' : 'library', inst.owner, 'top');
  }
  // Exiled rather than buried when it was cast with flashback, countered or not (CR 702.33a).
  return spellLeavesStack(next, object, inst);
}

/**
 * "Return target spell to its owner's hand" (D1337): Unsubstantiate, Venser, Hullbreaker Horror.
 * Not a counter, so "can't be countered" does not stop it and nothing that watches for a counter
 * sees one: the spell leaves the stack for its owner's hand, or for exile when flashback or a
 * graveyard permission says it must (CR 702.34a). A copy has no card and simply ceases to exist.
 */
export function returnSpellToHand(state: GameState, id: string): GameState {
  const object = state.stackObjects[id];
  if (object === undefined || object.kind !== 'spell') return state;
  const objects = { ...state.stackObjects };
  delete objects[id];
  const next: GameState = { ...state, stackObjects: objects, stackOrder: state.stackOrder.filter((o) => o !== id) };
  const inst = next.instances[id];
  if (inst === undefined) return next;
  const exiled = object.flashback === true || object.yardExile === true;
  return relocate(next, inst, exiled ? 'exile' : 'hand', inst.owner, 'bottom');
}

/**
 * "You may play an additional land this turn" (CR 505.5b): an Explore, an Azusa.
 *
 * A permission rather than a land: nothing is put onto the battlefield here, and the seat may use
 * it or not. It is added to a per-turn count the land-drop rule reads, so the order the player
 * does things in does not matter — casting Explore before or after the turn's first land is the
 * same two lands either way, which is the only reading of the card that is not a trap.
 */
export function allowExtraLand(state: GameState, seat: SeatIndex, count = 1): GameState {
  const key = String(seat);
  return {
    ...state,
    extraLands: { ...state.extraLands, [key]: (state.extraLands[key] ?? 0) + Math.max(0, count) },
  };
}

/**
 * Copies an ability already on the stack (CR 706.10): a Strionic Resonator, a Lithoform Engine.
 *
 * The copy is *created* on the stack rather than activated or triggered, which is the whole of why
 * this is a few fields rather than a call into the engine: nothing is cast, no cost is paid, no
 * cast or activation trigger fires, and the copy is above the original so it resolves first. It
 * reaches the stack directly for the same reason `counterSpell` does — `automation.ts` imports this
 * module, so routing through it would only buy a cycle.
 *
 * Everything that makes the original resolve the way it does is carried over: `source` and
 * `cardKey` and `abilityIndex` are what `resolveTop` looks the script up by, and the four fields
 * that say what the original was *about* — the object it answers, the permanent it is about, whose
 * action caused it, what the attack was aimed at — travel with it, because a copy of "whenever that
 * creature dies, you gain 1 life" that had forgotten which creature would do nothing at all.
 *
 * `aimedAt` is the printed "you may choose new targets for the copy", and it arrives as the answer
 * to a `TargetDecisionSpec` asked while the Resonator's own ability resolves — so the choice is
 * made from the board at that moment rather than when the ability was activated. Absent means the
 * copy keeps what the original chose, which is always a legal answer and has a consequence worth
 * knowing: a copied Gravedigger trigger left pointing at a card the original already returned is
 * countered on resolution for having no legal target left (CR 608.2b), exactly as the rules say.
 *
 * The target sequence numbers travel **only with a target that moved**, which is the subtle half
 * (CR 400.7). They are what the fizzle check compares a target against, so a copy aimed somewhere
 * new needs the numbers of *now*; a copy that kept the original's targets needs the original's
 * numbers, because then it is pointed at the same objects the original was and has to fizzle with
 * it when one of them has been replaced by a new object.
 *
 * `controller` is the controller of the *copying* effect, not of the original. Nothing in the pool
 * can copy somebody else's ability — Strionic Resonator says "you control" — but the rules put the
 * copy under the copier either way, and a field that quietly meant the other thing would be wrong
 * the day a card does.
 */
export function copyAbilityOnStack(
  state: GameState, id: string, controller: SeatIndex, aimedAt?: Target,
): GameState {
  const object = state.stackObjects[id];
  // A spell is copied by `copySpellOnStack`, which has a card to not copy. Copying one into a
  // *permanent* is a third thing again and a different card (Cackling Counterpart).
  if (object === undefined || object.kind === 'spell') return state;
  const seq = state.autoSeq + 1;
  const copyId = `ab${seq}`;
  const moved = aimedAt !== undefined && object.targets.length === 1;
  const copy: StackObject = {
    ...object,
    id: copyId,
    controller,
    ...(moved ? { targets: [aimedAt!], targetSeqs: targetSeqsFor(state, [aimedAt!]) } : {}),
    description: `${object.description} (copy)`,
  };
  return {
    ...state,
    autoSeq: seq,
    stackObjects: { ...state.stackObjects, [copyId]: copy },
    // On top, so it resolves before the ability it was copied from.
    stackOrder: [...state.stackOrder, copyId],
  };
}

/**
 * Copies a **spell** already on the stack (CR 707.10): a Twincast, a Reverberate, a Fork.
 *
 * The sibling of `copyAbilityOnStack` and a different thing in one way that matters more than it
 * looks: a spell is a *card*, and the copy is not. So the copy gets a stack id of its own rather
 * than the card's, and `instances[copy.id]` is deliberately empty — which is how the resolution
 * knows to run the effect and then let the copy cease to exist, instead of putting a second
 * graveyard card there that was never in anybody's deck. Everything in `completeResolution` that
 * moves a spell's card is already written as "if there is an instance", so this needed nothing
 * added there; `source` is the field it reads to find the card, and for a copy that is the
 * original's instance, which is why `source` is copied rather than reset to the new id.
 *
 * **The copy is not cast.** Nothing here goes through `castSpell`, so no cost is paid, no cast
 * trigger fires, and a Guttersnipe does not deal two damage for it. That is the rule (CR 707.10 —
 * "a copy of a spell is not cast") and it is also the only thing a person at this table would
 * notice getting wrong: Arc Tempest is a deck of cast triggers, and a copy that rang them all
 * would be quietly playing a different game in the player's favour.
 *
 * `aimedAt` is the answer to "you may choose new targets for the copy", and it arrives from a
 * `TargetDecisionSpec` asked while the copy effect resolves — so the choice is made from the board
 * as it is at that moment. Absent means the copy keeps what the original chose, which is always a
 * legal answer. The **target sequence numbers move with a target that moved and not otherwise**,
 * which is the one subtle part: they are what the fizzle check compares a target against
 * (CR 400.7), so a copy aimed somewhere new needs the numbers of now, and a copy that kept the
 * original's targets needs the original's numbers so that it fizzles alongside it.
 *
 * Above the original on the stack, so the copy resolves first — which is both the rule and the
 * reason the card is good: the copy resolves while the original is still there to be answered.
 */
export function copySpellOnStack(
  state: GameState, id: string, controller: SeatIndex, aimedAt?: Target,
): GameState {
  const object = state.stackObjects[id];
  // An ability is copied by `copyAbilityOnStack`, which is a shorter job: it has no card at all.
  if (object === undefined || object.kind !== 'spell') return state;
  const seq = state.autoSeq + 1;
  const copyId = `cp${seq}`;
  // One target replaced, and only when there was exactly one to replace: a spell with several
  // targets, or with a divided quantity, is copied as it was aimed and divided (CR 706.10c).
  const moved = aimedAt !== undefined && object.targets.length === 1;
  const copy: StackObject = {
    ...object,
    id: copyId,
    controller,
    copyOf: object.id,
    ...(moved ? { targets: [aimedAt!], targetSeqs: targetSeqsFor(state, [aimedAt!]) } : {}),
    description: `${object.description} (copy)`,
  };
  /*
    And the copy is recorded, which is magecraft's "or copy" half (see `GameState.copied`).

    Recorded here rather than announced by the caller, because this is the one place a copy is
    made and therefore the one place that cannot forget — the same argument the whole
    `died`/`left`/`entered`/`exiled` family is built on. `raise` lives above this module, so
    `settle` turns the record into the event.

    The **types** are read off the copied card rather than stored as a reference, because a stack
    object is gone by the time anything reads it. `typeLine` is parsed the same way a cast's event
    does it, so "instant or sorcery" means the same thing either way round.
  */
  const copiedDef = state.cardDefs[object.cardKey];
  const copiedLine = parseTypeLine(copiedDef?.typeLine);
  const types = copiedLine.types.map((t) => t.toLowerCase());
  /*
    And its colours and mana value, for the cast filters that are facts about the spell rather than
    about its type line (D474). A copy has the copied spell's characteristics (CR 707.2), and the
    mana value of a copy of an {X} spell counts the X the original was cast for (CR 706.10) — which
    is what the stack object carries. `printedColors` rather than `def.colors` because card data
    carries the colours as plain strings, and a filter against the engine's own five keeps a
    malformed printing from smuggling a sixth colour into an event.
  */
  const colors = printedColors(copiedDef);
  const manaValue = (copiedDef?.cmc ?? 0) + (object.x ?? 0);
  return {
    ...state,
    autoSeq: seq,
    stackObjects: { ...state.stackObjects, [copyId]: copy },
    stackOrder: [...state.stackOrder, copyId],
    ...(state.automated
      ? {
        copied: [...(state.copied ?? []), {
          types, subtypes: copiedLine.subtypes, controller, colors, manaValue,
        }],
      }
      : {}),
  };
}

/**
 * Ward (CR 702.21b): counter the spell or ability that targeted this, unless its controller pays.
 *
 * Two things happen here and only one of them is a choice. **The payment is a choice**, so the
 * table stops and asks: `pendingPayment` names who is being asked, what for, and which object goes
 * away if the answer is no, because by the time the answer arrives this ability has left the stack
 * and nothing else remembers what it was about.
 *
 * **Not being able to pay is not a choice**, so it is not offered as one. A player with one
 * untapped land facing a Ward {3} has exactly one outcome available, and asking them to confirm it
 * would be a prompt with a single button — the same rule that keeps a trigger with no legal
 * targets off the stack entirely. That half is `settlePayment` in `automation.ts` rather than here:
 * answering "can this be afforded" needs the list of what is left to tap, which is `manaSources`,
 * and this module is below that one. Nothing can change between the two points — nobody holds
 * priority while a ward is outstanding — so where the question is asked does not change the answer.
 *
 * And a ward whose object has already left the stack does nothing at all: something else countered
 * the spell first, or it resolved, which is the ordinary "its target is gone" case one level up.
 */
export function wardAsks(ctx: EffectContext, cost: string, name: string, life = 0, discard = 0): GameState {
  const { state } = ctx;
  const id = ctx.answering;
  if (id === undefined) return state;
  const object = state.stackObjects[id];
  if (object === undefined) return state;
  const payer = object.controller;
  const words = paymentWords({ cost, life, discard });
  return {
    ...state,
    // Nobody holds priority while the question is outstanding, for the reason `pendingChoice` and
    // `pendingDecision` do it: a seat named here is a seat whose table offers a pass the engine
    // then refuses.
    priority: null,
    passed: [],
    pendingPayment: {
      seat: payer,
      cost,
      ...(life > 0 ? { life } : {}),
      ...(discard > 0 ? { discard } : {}),
      prompt: `${discard > 0 && cost === '' && life <= 0 ? '' : 'Pay '}${discard > 0 && cost === '' && life <= 0 ? words.charAt(0).toUpperCase() + words.slice(1) : words} or ${object.description} is countered by ${name}'s ward`,
      counters: id,
      source: ctx.source,
      // The wording `settlePayment` used to build for itself. See `pendingPayment.unpaidNote`.
      unpaidNote: `${name}: ward ${words} was not paid — ${object.description} is countered`,
    },
  };
}

/**
 * What a pending payment costs, in the words a player reads: `{2}`, `3 life`, `{2} and 2 life`.
 *
 * One function because three places say it — the prompt, the button, and the log line when it is
 * paid or refused — and a cost said three ways is how one of them ends up naming only the mana.
 * A mana-only payment reads exactly as it did before life could be part of one.
 */
export function paymentWords(payment: { readonly cost: string; readonly life?: number; readonly discard?: number }): string {
  // A discard (D1327): "discard a card", alone or after the rest.
  const discard = payment.discard ?? 0;
  if (discard > 0) {
    const rest = paymentWords({ cost: payment.cost, life: payment.life ?? 0 });
    const card = discard === 1 ? 'discard a card' : `discard ${discard} cards`;
    return rest === '' ? card : `${rest} and ${card}`;
  }
  const life = payment.life ?? 0;
  if (life <= 0) return payment.cost;
  return payment.cost === '' ? `${life} life` : `${payment.cost} and ${life} life`;
}

/**
 * "Counter target spell unless its controller pays {N}" (CR 118.8) — the same mechanism as ward,
 * from the other side of the table.
 *
 * Ward asks the player who did the targeting; this asks the player whose spell is being answered.
 * Both are the same question — pay, or this object leaves the stack — and `pendingPayment` was
 * built for exactly the shape where the seat being asked is **not** the controller of the thing
 * resolving, which its own docblock says in as many words. So this is a second raiser of an
 * existing field rather than a new kind of pause, and the half that is not a choice — a player who
 * cannot afford it is not asked — is `settlePayment`'s, already shared.
 *
 * The one difference from ward is **when**: ward raises its payment from a triggered ability, this
 * one from the counterspell's own resolution. Nothing in the engine clears a pending payment at the
 * end of a resolution (the three places that clear one are a seat leaving, the game ending, and a
 * reset), so the question outlives the spell that asked it — which it has to, because the spell is
 * gone by the time the answer arrives.
 *
 * Takes the object from `ctx.targets` rather than `ctx.answering`: the counterspell *targeted* the
 * spell, where a ward was told which object had targeted it.
 */
export function counterUnlessPaid(ctx: EffectContext, cost: string, name: string): GameState {
  const { state } = ctx;
  const target = ctx.targets.find((one) => one.kind === 'card');
  if (target === undefined || target.kind !== 'card') return state;
  const object = state.stackObjects[target.id];
  // Already countered or already resolved: the ordinary "its target is gone" case (CR 608.2b).
  if (object === undefined) return state;
  return {
    ...state,
    // Nobody holds priority while the question is outstanding — `wardAsks`'s reason, unchanged.
    priority: null,
    passed: [],
    pendingPayment: {
      seat: object.controller,
      cost,
      prompt: `Pay ${cost} or ${object.description} is countered by ${name}`,
      counters: target.id,
      source: ctx.source,
      unpaidNote: `${name}: ${cost} was not paid — ${object.description} is countered`,
      // The rider travels with the question (D545): the counter happens at `settlePayment`, which
      // is a different action in a different turn of the reducer, so the fact has to be in state.
      ...(ctx.exileWhenCountered === true ? { exileWhenCountered: true as const } : {}),
    },
  };
}

/**
 * Exiles the top `count` cards of `seat`'s library and tells that seat it may **play** them until
 * the deadline (D583) — "Exile the top card of your library. You may play that card this turn."
 *
 * Face up, because the printed effect exiles them face up and the whole table sees what was
 * turned over. Fewer cards than asked is not an error: a library with one card left gives one.
 *
 * What makes them playable is `CardInstance.playFromExile`, which `legalActions` offers and
 * `castSpell` and `playLand` accept; nothing here casts anything.
 */
export function exileTopToPlay(
  state: GameState, seat: SeatIndex, count: number,
  through: NonNullable<CardInstance['playFromExile']>['through'],
  /** Whose library (D1236): Ragavan's "the top card of that player's library". Its owner's exile. */
  librarySeat: SeatIndex = seat,
  castOnly = false,
  free = false,
): GameState {
  let next = state;
  for (let i = 0; i < Math.max(0, count); i++) {
    const top = listAt(next, zoneKey(librarySeat, 'library'))[0];
    if (top === undefined) break;
    const inst = next.instances[top];
    if (inst === undefined) break;
    next = relocate(next, inst, 'exile', inst.owner, 'bottom');
    next = withInstance(next, inst.id, {
      faceDown: false,
      playFromExile: {
        by: seat, grantedTurn: next.turn, through,
        ...(castOnly ? { castOnly: true as const } : {}), ...(free ? { free: true as const } : {}),
      },
    });
  }
  return next;
}

/** Puts the top `count` cards of a library into its owner's graveyard. */
export function mill(state: GameState, seat: SeatIndex, count: number): GameState {
  let next = state;
  for (let i = 0; i < Math.max(0, count); i++) {
    const top = listAt(next, zoneKey(seat, 'library'))[0];
    if (top === undefined) break;
    const inst = next.instances[top];
    if (inst === undefined) break;
    next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/**
 * Discards cards at random from a hand.
 *
 * "At random" is the only kind of discard the engine can carry out, because a discard the *player*
 * chooses is a decision during resolution and there is no way to ask for one — see the header of
 * `scripts.ts`. A card that says "discards a card" of their choosing is therefore not scripted
 * rather than quietly made random, which would be a different and worse card.
 *
 * The randomness is the engine's own seeded stream, so a replayed game discards the same cards.
 */
/**
 * Shuffles one seat's library (D651) — "You may shuffle" after Ponder's look, and any other effect
 * that shuffles without searching. Seeded from the game, like every other shuffle here.
 */
export function shuffleLibrary(state: GameState, seat: SeatIndex): GameState {
  const key = zoneKey(seat, 'library');
  const seq = state.autoSeq + 1;
  const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion + seq));
  return { ...state, autoSeq: seq, zones: { ...state.zones, [key]: shuffled(listAt(state, key), rng) } };
}

/**
 * "Flip a coin" (D1152, CR 705.1): heads or tails off the game's seeded generator, as a shuffle is.
 * Nothing chooses a side, so the flip is won or lost with even odds and recorded in `coinFlips`.
 */
export function flipCoin(state: GameState, seat: SeatIndex): { readonly state: GameState; readonly won: boolean } {
  const seq = state.autoSeq + 1;
  const won = mulberry32(actionSeed(state.rngSeed, state.stateVersion + seq))() < 0.5;
  const flips = [...(state.coinFlips ?? []), { seat, won }].slice(-20);
  return { state: { ...state, autoSeq: seq, coinFlips: flips }, won };
}

/** "Roll a d20" (D1154, CR 706.1): 1 to `sides`, off the game's seeded generator, recorded in `dieRolls`. */
export function rollDie(state: GameState, seat: SeatIndex, sides: number): { readonly state: GameState; readonly result: number } {
  const seq = state.autoSeq + 1;
  const result = 1 + Math.floor(mulberry32(actionSeed(state.rngSeed, state.stateVersion + seq))() * sides);
  const rolls = [...(state.dieRolls ?? []), { seat, sides, result }].slice(-20);
  return { state: { ...state, autoSeq: seq, dieRolls: rolls }, result };
}

export function discardAtRandom(state: GameState, seat: SeatIndex, count: number): GameState {
  let next = state;
  for (let i = 0; i < Math.max(0, count); i++) {
    const hand = listAt(next, zoneKey(seat, 'hand'));
    if (hand.length === 0) break;
    const seq = next.autoSeq + 1;
    const roll = mulberry32(actionSeed(next.rngSeed, next.stateVersion + seq))();
    const pick = hand[Math.min(hand.length - 1, Math.floor(roll * hand.length))];
    const inst = pick === undefined ? undefined : next.instances[pick];
    if (inst === undefined) break;
    next = relocate({ ...next, autoSeq: seq }, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/**
 * A draw this seat is owed but has not taken, which a dredge may replace (CR 702.52a).
 *
 * `draw` takes the card now; this one adds it to `GameState.drawsOwed` and lets `settle` take it,
 * which is the only way a draw in this engine can be *replaced*. Nothing here knows what dredge is
 * — the lookup needs a card's script and this module sits below that — so the deferral is blind and
 * the layer above decides what to do with it.
 *
 * **Only for a draw that is the last thing the card does.** An effect that reads what it drew in
 * the same breath — Dark Confidant charging you for the card's mana value, Faithless Looting
 * offering the two cards it just drew to discard — must call `draw`, because by the time this one's
 * card arrives the effect has finished. The compiler cannot tell the two apart, which is why the
 * rule is written here and why the pool opts in one card at a time rather than all at once.
 */
export function drawLater(state: GameState, seat: SeatIndex, count: number): GameState {
  if (count <= 0) return state;
  return {
    ...state,
    drawsOwed: [...state.drawsOwed, ...Array.from({ length: Math.floor(count) }, () => seat)],
  };
}

export function draw(state: GameState, seat: SeatIndex, wanted: number): GameState {
  // Narset and Spirit of the Labyrinth (D1233): only as many as the turn's limit leaves.
  const count = Math.min(wanted, drawsAllowed(state, seat));
  if (count <= 0) return state;
  /*
    Notion Thief (D891, CR 614.1a): each card an opponent of its controller would draw, except the first
    in their own draw step, is skipped and the Thief's controller draws one instead. The draw step's
    first card is the one they draw there before any other this turn; draws that were replaced were not
    theirs, so they do not count towards it.
  */
  const thief = count > 0 ? drawThiefAgainst(state, seat) : undefined;
  if (thief !== undefined) {
    const exempt = state.step === 'draw' && state.activeSeat === seat && drawnThisTurn(state, seat) === 0 ? 1 : 0;
    const kept = Math.min(count, exempt);
    const own = kept > 0 ? drawUnreplaced(state, seat, kept) : state;
    // The stolen draw is drawn as it is, not offered to another Thief: two Thieves on opposite sides
    // would otherwise pass one card back and forth without end. A deliberate simplification.
    return Array.from({ length: count - kept }).reduce<GameState>((s) => drawUnreplaced(s, thief, 1), own);
  }
  return drawUnreplaced(state, seat, count);
}

/** How many more cards `seat` may draw this turn under every live `drawLimit` that reaches it (D1233). */
function drawsAllowed(state: GameState, seat: SeatIndex): number {
  if (scriptLookup === null) return Number.POSITIVE_INFINITY;
  const lookup = scriptLookup;
  let allowed = Number.POSITIVE_INFINITY;
  for (const other of state.seats) {
    for (const id of listAt(state, zoneKey(other.index, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) continue;
      const limit = lookup(state.cardDefs[inst.defKey])?.drawLimit;
      if (limit === undefined) continue;
      if (limit.who === 'opponents' && other.index === seat) continue;
      if (limit.who === 'you' && other.index !== seat) continue;
      allowed = Math.min(allowed, limit.perTurn - drawnThisTurn(state, seat));
    }
  }
  return Math.max(0, allowed);
}

/** The seat of an opponent of `seat` whose Notion Thief takes `seat`'s draws (D891), if any. */
function drawThiefAgainst(state: GameState, seat: SeatIndex): SeatIndex | undefined {
  if (scriptLookup === null) return undefined;
  const lookup = scriptLookup;
  for (const other of state.seats) {
    if (other.index === seat || other.eliminated) continue;
    const has = listAt(state, zoneKey(other.index, 'battlefield')).some((id) => {
      const inst = state.instances[id];
      if (inst === undefined || inst.faceDown || allAbilitiesLost(state, inst)) return false;
      return lookup(state.cardDefs[inst.defKey])?.stealsExtraDraws === true;
    });
    if (has) return other.index;
  }
  return undefined;
}

function drawUnreplaced(state: GameState, seat: SeatIndex, count: number): GameState {
  const result = drawFromLibrary(state, seat, count);
  /*
    One `drew` entry per card that actually arrived, for `settle` to announce. See `GameState.drew`
    for why it is recorded here rather than worked out by comparing hands: every path that draws a
    card comes through this function — the draw step, the crown, and two dozen card effects — and
    no other path puts a card in a hand *by drawing it*.

    Each entry carries the card and its place in the seat's turn, and the running total moves with
    them. `before` is read once rather than per card so the ordinals are the seat's own draws since
    the turn began — the first card of a `draw(2)` on an untouched turn is `nth: 1` and the second
    is `nth: 2`, which is the distinction miracle is about.
  */
  const key = String(seat);
  const before = result.state.cardsDrawnThisTurn[key] ?? 0;
  const drew = result.cards.length > 0
    ? [...result.state.drew, ...result.cards.map((card, i) => ({ seat, card, nth: before + i + 1 }))]
    : result.state.drew;
  const cardsDrawnThisTurn = result.cards.length > 0
    ? { ...result.state.cardsDrawnThisTurn, [key]: before + result.cards.length }
    : result.state.cardsDrawnThisTurn;
  // A player who could not draw has lost (CR 704.5b) — recorded here, acted on by state-based
  // actions, because losing is not Harmonize's business.
  // D852: a Laboratory Maniac on the drawing seat's side wins instead (CR 614.1a).
  if (result.drawn < count && winsOnEmptyDraw(result.state, seat)) {
    const won = result.state.seats.reduce(
      (s, other) => (other.index === seat || other.eliminated ? s : loseTheGame(s, other.index)), result.state);
    return { ...won, drew, cardsDrawnThisTurn };
  }
  if (result.drawn < count && !result.state.drewFromEmpty.includes(seat)) {
    return {
      ...result.state, drew, cardsDrawnThisTurn,
      drewFromEmpty: [...result.state.drewFromEmpty, seat],
    };
  }
  return { ...result.state, drew, cardsDrawnThisTurn };
}

/** How many cards this seat has drawn since the turn began. See `GameState.cardsDrawnThisTurn`. */
export const drawnThisTurn = (state: GameState, seat: SeatIndex): number =>
  state.cardsDrawnThisTurn[String(seat)] ?? 0;

/**
 * Miracle (CR 702.94a): the card you just drew, offered for its miracle cost before anything else.
 *
 * `madnessOffer`'s sibling, and the differences are the two things that make the keyword what it
 * is. The card is **not moved**: madness exiles the card it interrupted on its way to a graveyard,
 * while a miracle card is revealed from the hand it has just arrived in and cast from there, so
 * declining leaves it in hand to be cast later for its printed cost — which is `stays`.
 *
 * And the window is the draw itself. Nothing else in this engine offers a cast at a moment that is
 * not a resolution: the offer is set while `settle` is draining the draws, before the drawing seat
 * is given priority, which is what "when you draw it" means and why a sorcery with miracle can be
 * cast on somebody else's turn.
 */
/**
 * Rebound (CR 702.88a): the card is in exile, and this is its one free casting.
 *
 * The shortest of the four offers, because everything that makes the other three interesting has
 * already happened: there is no pile to put back, no cost to price, and no zone change to finish.
 * The card is sitting in exile where the resolution put it, and all this does is stop the table and
 * say it may be cast for nothing.
 *
 * `stays` is miracle's flag doing a second job. Declining a rebound leaves the card in exile for
 * the rest of the game — which is "do not move it", the same disposition as a miracle card left in
 * the hand it was drawn into, and a fourth flag for the same behaviour would be a fourth thing to
 * keep in step.
 */
/**
 * Suspend's last time counter has come off: the card is cast, and it is not a request
 * (CR 702.62c).
 *
 * The fourth offer and the only **mandatory** one. Three of them are permissions — cascade,
 * madness and miracle all say "you may" — and the player who declines has made a real choice.
 * Suspend does not: the rules say you cast it. So the offer carries `mandatory`, `legalActions`
 * offers no pass while it stands, and the only way past the question is the cast.
 *
 * What happens when the cast **cannot** be made is the rule rather than an edge case: a Rift Bolt
 * with nothing to point at stays in exile. That falls out of the machinery — `settleOffer` takes
 * back an offer nobody can take, and the card's time counters are already gone, so nothing offers
 * it again.
 */
export function suspendedCast(state: GameState, card: string): GameState {
  const inst = state.instances[card];
  if (inst === undefined || inst.zone !== 'exile') return state;
  const name = state.cardDefs[inst.defKey]?.name ?? 'it';
  return {
    ...state,
    pendingOfferedCast: {
      seat: inst.owner,
      card,
      prompt: `${name}'s last time counter is gone: cast it without paying its mana cost`,
      stays: true,
      mandatory: true,
      source: card,
    },
  };
}

export function reboundOffer(state: GameState, card: string): GameState {
  const inst = state.instances[card];
  if (inst === undefined || inst.zone !== 'exile') return state;
  const name = state.cardDefs[inst.defKey]?.name ?? 'it';
  return {
    ...state,
    pendingOfferedCast: {
      seat: inst.owner,
      card,
      prompt: `${name} rebounds: you may cast it from exile without paying its mana cost`,
      stays: true,
      source: card,
    },
  };
}

export function miracleOffer(state: GameState, card: string, cost: string): GameState {
  const inst = state.instances[card];
  if (inst === undefined) return state;
  const name = state.cardDefs[inst.defKey]?.name ?? 'it';
  return {
    ...state,
    pendingOfferedCast: {
      seat: inst.owner,
      card,
      cost,
      prompt: `${name} is the first card you drew this turn: you may cast it for ${cost} (miracle)`,
      stays: true,
      source: card,
    },
  };
}

/**
 * "You lose the game" (D690, CR 104.3a): the seat leaves at once, as a conceding one does. The
 * engine's elimination pass then takes away what it owns (CR 800.4a).
 */
export function loseTheGame(state: GameState, seat: SeatIndex): GameState {
  if (state.seats[seat] === undefined || state.seats[seat]!.eliminated) return state;
  if (cantLoseTheGame(state, seat)) return state;
  return replaceSeat(state, seat, { eliminated: true, eliminatedReason: 'effect' });
}

export function tap(state: GameState, id: string, tapped = true): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  if (!tapped) return untapPermanent(state, id);
  /*
    Already tapped: nothing happens, and the board says so by being the same board (D1063). A
    tapped permanent cannot become tapped (CR 701.26a), so "you may tap target creature. If you do,
    …" did not happen, and `optionalEffect` reads "if you do" off exactly this identity.
  */
  if (inst.tapped === true) return state;
  return withInstance(state, id, { tapped });
}

/**
 * Untaps a permanent, unless a stun counter stops it (D723, CR 122.1d): "If a permanent with a stun
 * counter on it would become untapped, instead remove a stun counter from it." Only a permanent
 * that is tapped would become untapped, so an untapped one keeps its counters. Every untap the
 * engine makes goes through here: the untap step, an untap effect, and a {Q} cost.
 */
export function untapPermanent(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || !inst.tapped) return state;
  if ((inst.counters['stun'] ?? 0) > 0) return addCounters(state, id, 'stun', -1);
  return withInstance(state, id, { tapped: false });
}

/**
 * Schedules one, from inside the effect that creates it. See `DelayedTrigger`.
 *
 * `abilityIndex` is the card's own `triggers` entry, which is how the ability gets a resolution
 * path, targets and a description without a second mechanism: by the time it fires it is an
 * ordinary triggered ability on the stack and nothing downstream knows it waited.
 */
export function scheduleDelayed(
  state: GameState,
  spec: {
    readonly source: string;
    readonly controller: SeatIndex;
    readonly abilityIndex: number;
    readonly step: Step;
    readonly of: 'you' | 'any';
    readonly subject?: string;
    readonly description: string;
    readonly builtin?: 'sacrifice' | 'exile' | 'to-hand' | 'destroy' | 'return-to-owner' | 'return-to-you' | 'draw' | 'remove-plus-one';
    readonly onDeath?: true;
  },
): GameState {
  const seq = state.autoSeq + 1;
  /*
    Which object the subject is *now*, so the ability cannot act on its replacement (CR 400.7).

    Taken here because here is the only moment it is knowable: by the time the ability fires the
    card may have been blinked, and the id alone cannot tell that apart from never having moved.
    See `DelayedTrigger.subjectSeq`.
  */
  const subjectSeq = spec.subject === undefined
    ? undefined
    : state.instances[spec.subject]?.objectSeq ?? 0;
  return {
    ...state,
    autoSeq: seq,
    delayed: [...state.delayed, {
      id: `dl${seq}`,
      ...spec,
      ...(subjectSeq === undefined ? {} : { subjectSeq }),
      createdTurn: state.turn,
      createdStep: state.step,
    }],
  };
}

/**
 * "You become the monarch" (CR 720.3).
 *
 * One line, and the reason it is a function at all is that it is the only thing a card ever does
 * to the crown: everything else about the monarch — the draw at the beginning of its own end step,
 * and the crown changing hands to whoever connects with it — is a rule of the game rather than
 * text on a card, and lives in the engine where the other turn-based actions do.
 *
 * An eliminated seat cannot be crowned, which matters in a pod: the rule that clears the crown when
 * its holder leaves the game (CR 720.6) would otherwise have to undo this a moment later.
 */
export function becomeMonarch(state: GameState, seat: SeatIndex): GameState {
  if (state.seats[seat] === undefined || state.seats[seat]?.eliminated === true) return state;
  if (state.monarch === seat) return state;
  return { ...state, monarch: seat };
}

export function untapAll(
  state: GameState, seat: SeatIndex,
  opts: { readonly othersStep?: boolean; readonly keep?: ReadonlySet<string> } = {},
): GameState {
  let next = state;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    /*
      Seedborn Muse's untap (D661) happens in somebody else's untap step, which is not "its
      controller's next untap step": a frozen permanent stays down and stays frozen for its own.
    */
    if (opts.othersStep === true && inst.frozen === true) continue;
    /*
      A frozen permanent does not untap, and is not frozen afterwards (CR 502.2).

      Cleared here whether or not it was tapped, because "doesn't untap during its controller's
      next untap step" is spent by the step happening rather than by an untap being prevented: a
      creature frozen while already untapped has used the effect up, and leaving the flag on would
      hold it down through the following turn as well.
    */
    if (inst.frozen === true) {
      next = withInstance(next, id, { frozen: false });
      continue;
    }
    // And one held down for as long as an effect says so (D589): Apathy, a Basalt Monolith.
    if (inst.tapped && characteristicsOf(next, inst).doesntUntap) continue;
    // And one its controller chose to keep tapped (D1041, CR 502.3): see `CardScript.mayStayTapped`.
    if (opts.keep?.has(id) === true) continue;
    // Through the stun counter's replacement (D723, CR 122.1d).
    if (inst.tapped) next = untapPermanent(next, id);
  }
  return next;
}

/**
 * "That creature doesn't untap during its controller's next untap step" — Wall of Frost's clause.
 *
 * Does not tap the permanent and does not care whether it is tapped: the two are separate
 * sentences on every card that says this, and a Wall of Frost blocks a creature that is *already*
 * tapped from attacking (attacking tapped it) and holds it down next turn, which is the whole card.
 */
export function freezeNextUntap(state: GameState, id: string): GameState {
  if (state.instances[id] === undefined) return state;
  return withInstance(state, id, { frozen: true });
}

/**
 * The prefix that makes a **player** answerable to a question whose other answers are cards.
 *
 * Proliferate's candidate list is mixed (CR 701.27a), and an answer travels down a socket as a list
 * of strings — so a player has to be one of them. `seat:1` rather than a bare number because the
 * list is checked against instance ids, and an answer that happened to collide with one would be
 * exactly the bug that checking exists to prevent.
 */
export const SEAT_CHOICE = 'seat:';

/**
 * Marks an echo as settled, whether it was paid or not (CR 702.29b).
 *
 * Lives here rather than in the trigger that calls it because a card's script writes effects and
 * does not reach into instances — and because the flag's two setters are in this module and in the
 * arrivals pass, so its one clearer belongs beside them.
 */
export const echoSettled = (state: GameState, id: string): GameState =>
  state.instances[id] === undefined ? state : withInstance(state, id, { echoDue: undefined });

/**
 * Proliferate: one more of **each kind of counter already there**, on each thing chosen
 * (CR 701.27a).
 *
 * The keyword that touches everything this engine counts — +1/+1 and -1/-1, loyalty, poison,
 * energy, lore on a Saga, charge on an artifact — and it adds nothing new to anything. A permanent
 * with two kinds of counter on it gets one of each; a permanent with none is not a legal choice and
 * never reaches here.
 *
 * Two things it deliberately does not do. It does not touch a **suspended card**: time counters sit
 * on a card in exile, which is not a permanent, so proliferate cannot hurry a Rift Bolt along — the
 * same answer paper gives and the thing people most often expect of this keyword. And poison is
 * read off its own field rather than the counters record, because that is where a seat keeps it.
 */
export function proliferate(state: GameState, chosen: readonly string[]): GameState {
  let next = state;
  for (const id of chosen) {
    if (id.startsWith(SEAT_CHOICE)) {
      const seat = Number(id.slice(SEAT_CHOICE.length)) as SeatIndex;
      const player = next.seats[seat];
      if (player === undefined || player.eliminated) continue;
      const counters: Record<string, number> = { ...player.counters };
      for (const [key, value] of Object.entries(counters)) {
        if (value > 0) counters[key] = clampValue(value + 1);
      }
      next = replaceSeat(next, seat, {
        counters,
        ...(player.poison > 0 ? { poison: clampValue(player.poison + 1) } : {}),
      });
      continue;
    }
    const inst = next.instances[id];
    if (inst === undefined || inst.zone !== 'battlefield') continue;
    for (const [key, value] of Object.entries(inst.counters)) {
      if (value > 0 && !MARKERS.has(key)) next = addCounters(next, id, key, 1);
    }
  }
  return next;
}

/**
 * Moves one counter of `key` from one permanent to another (D1093): graft's "you may move a +1/+1
 * counter from this creature onto it". Nothing happens unless `from` has one and `to` is on the
 * battlefield. Moving is not putting (CR 122.6), so Hardened Scales and Doubling Season do not
 * change how many arrive: the counters are edited directly rather than through `addCounters`.
 */
export function moveCounter(state: GameState, from: string, to: string, key = '+1/+1'): GameState {
  const source = state.instances[from];
  const target = state.instances[to];
  if (source === undefined || target === undefined || from === to) return state;
  if (source.zone !== 'battlefield' || target.zone !== 'battlefield') return state;
  const have = source.counters[key] ?? 0;
  if (have <= 0) return state;
  const left = { ...source.counters };
  if (have === 1) delete left[key];
  else left[key] = have - 1;
  return {
    ...state,
    instances: {
      ...state.instances,
      [from]: { ...source, counters: left },
      [to]: { ...target, counters: { ...target.counters, [key]: (target.counters[key] ?? 0) + 1 } },
    },
  };
}

export function addCounters(state: GameState, id: string, key: string, amount: number): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  /*
    A +1/+1 or -1/-1 counter goes on a **permanent**, and a card that has left the battlefield is
    not one (D566).

    "Whenever ~ is dealt damage, put a +1/+1 counter on it" is Fungusaur, and the damage that
    triggers it is often the damage that kills it: the ability resolves with its source in a
    graveyard, and without this the counter was written onto the card there — where `relocate`
    would carry it back onto the battlefield with the next Reanimate, a 3/3 arriving as a 4/4 with
    nothing on the table to say why. An effect that has lost its object does nothing to the new
    one (CR 400.7).

    Only the counters that mean something to a creature's size: +1/+1 and -1/-1, and since D1270
    every other power/toughness counter ("+2/+2", "-0/-1"). Time counters on a suspended card in
    exile are counters on a card that is deliberately not a permanent, and they are added through
    this same function.
  */
  if (/^[+-]\d+\/[+-]\d+$/.test(key) && inst.zone !== 'battlefield') return state;
  /*
    Hardened Scales, Corpsejack Menace, Doubling Season (D652): counters put on a permanent are
    replaced by more. Not a marker the engine keeps as a counter (a regeneration shield, "kicked"),
    and only counters put **on** — removing them is a cost or an effect nothing here replaces.
  */
  // Nor a Saga's lore counter, which arrives by turn-based action rather than by an effect (CR 714.3b).
  if (amount > 0 && inst.zone === 'battlefield' && !MARKERS.has(key) && key !== 'lore') {
    amount = countersAfterReplacement(state, inst, key, amount);
  }
  const value = clampValue((inst.counters[key] ?? 0) + amount);
  const counters = { ...inst.counters };
  if (value === 0) delete counters[key];
  else counters[key] = value;
  const placed = withInstance(state, id, { counters });
  /*
    "Whenever one or more +1/+1 counters are put on ~" (D633): recorded for `settle` to announce.
    Only the counters a card can name — not the regeneration shield, which is kept as a counter but
    is not one — only on the battlefield, and only when some were added: removing them is not
    putting them on. A permanent entering with counters gets them through here too, and that counts
    as putting them on (CR 122.6).
  */
  // And becoming monstrous (D992), for "When ~ becomes monstrous".
  /*
    And every other kind a card can name (D1300): "Whenever you put one or more counters on a
    creature" is any kind, and Kate Stewart's are time counters. Not the engine's own markers.
  */
  if (amount > 0 && inst.zone === 'battlefield' && (!MARKERS.has(key) || key === MONSTROUS)) {
    return {
      ...placed,
      countersPut: [...(placed.countersPut ?? []), { card: id, counter: key, amount, ...(state.countersBy === undefined ? {} : { by: state.countersBy }) }],
    };
  }
  return placed;
}

/**
 * "Create a token that's a copy of target creature" — layer 1, done by pointing at the printed card.
 *
 * A copy copies the card's **printed** characteristics, not what the creature currently is: a token
 * copy of a Grizzly Bears under three Giant Growths is a 2/2 (CR 707.2). So the copy is made by
 * handing `createToken` the copied card's own definition, and everything else follows without a
 * line of new rules — the token's abilities are the copied card's abilities because `scriptFor`
 * reads the name, and its statics are installed by the arrivals pass like any other permanent's.
 *
 * What this does *not* copy is everything that is not printed on the card: counters, damage, auras,
 * equipment and any effect on the original. That is the rule rather than a shortcut.
 */
export function copyAsToken(
  state: GameState, seat: SeatIndex, source: string, count = 1,
  profile?: TokenCopyProfile,
): GameState {
  const inst = state.instances[source];
  if (inst === undefined) return state;
  const def = state.cardDefs[inst.defKey];
  if (def === undefined) return state;
  if (profile === undefined) return createToken(state, seat, def, count);
  return createToken(state, seat, withProfile(def, profile), count, profileKey(def, profile));
}

/**
 * The characteristics an embalm or eternalize token has **instead** of the copied card's
 * (CR 702.89a, CR 702.100a).
 *
 * "A token that's a copy of it, except it's a white Zombie with no mana cost" is a copy effect with
 * a list of exceptions, and the exceptions are the only thing the engine did not already have.
 * Everything in the list is a printed characteristic, so the whole of it is one definition with
 * some fields replaced — and then the token is an ordinary token of an ordinary card definition,
 * read by `characteristicsOf` off its `defKey` like every other permanent.
 *
 * `as` is the part that is not a characteristic. `defKey` is a card's lowercased **name**, so an
 * altered definition under its own name would overwrite the printed card in `cardDefs` — the Sacred
 * Cat in your graveyard would become a Zombie too — or, because `createToken` keeps whatever is
 * already registered, be silently ignored. So the altered definition is registered under the card's
 * key plus this suffix (`sacred cat#embalmed`), which keeps the two apart while the token's `name`
 * stays the card's name. That matters for more than the label: `scriptFor` looks a script up by
 * **name**, which is what gives the token the copied card's abilities, exactly as the keyword says.
 *
 * The one thing deliberately left alone is `oracleText`, which still carries the embalm ability the
 * token can no longer use. That is not a bug worth fixing by rewriting the text: the ability is
 * gated on `fromGraveyard`, so it is never offered to a permanent on the battlefield, and a token
 * never reaches a graveyard to be offered it there. Printing the card's own text on the token is
 * also what a player wants to read.
 */
export interface TokenCopyProfile {
  /** What kind of copy this is, as a suffix on the definition's key: `embalmed`, `eternalized`. */
  readonly as: string;
  readonly typeLine?: string;
  readonly manaCost?: string;
  readonly cmc?: number;
  readonly colors?: readonly string[];
  /** Eternalize's "base power and toughness 4/4", which is a printed value and not a pump. */
  readonly power?: string;
  readonly toughness?: string;
  /**
   * Lines added to the copied card's text — "except it has flying" (D594). A keyword line, which
   * `printedKeywords` reads back as the keyword; nothing else is written here.
   */
  readonly extraText?: string;
}

const profileKey = (def: CardDef, profile: TokenCopyProfile): string =>
  `${defKeyFor(def)}#${profile.as}`;

const withProfile = (def: CardDef, profile: TokenCopyProfile): CardDef => ({
  ...def,
  ...(profile.typeLine === undefined ? {} : { typeLine: profile.typeLine }),
  ...(profile.manaCost === undefined ? {} : { manaCost: profile.manaCost }),
  ...(profile.cmc === undefined ? {} : { cmc: profile.cmc }),
  ...(profile.colors === undefined ? {} : { colors: [...profile.colors] }),
  ...(profile.power === undefined ? {} : { power: profile.power }),
  ...(profile.toughness === undefined ? {} : { toughness: profile.toughness }),
  ...(profile.extraText === undefined ? {} : {
    oracleText: def.oracleText === '' ? profile.extraText : `${def.oracleText}\n${profile.extraText}`,
  }),
  /*
    And no other faces. A token copy of a card is a copy of the card, not of a half of it — and a
    token that offered "cast the other half" would be offering a cast of something that is not a
    card at all. Nothing printed with embalm has a second face, so this is a guard rather than a
    rule anybody needs; `normaliseDef` would otherwise carry the faces straight through.
  */
  faces: undefined,
});

/**
 * "Enters the battlefield as a copy of any creature" — layer 1, applied to a permanent.
 *
 * The same move as `copyAsToken` from the other end: instead of making a new object from the copied
 * card, an existing one is pointed at it. `defKey` is the one field everything downstream reads —
 * characteristics, the script that gives it its abilities, the definition the table draws — so
 * nothing else in the engine has to learn that copying exists.
 *
 * `printedDefKey` remembers what the card actually is, and `relocate` puts it back when the
 * permanent leaves the battlefield, because that is when a copy effect ends. Called while the spell
 * is still on the stack, which is what "enters as" means: `completeResolution` runs the script
 * before it moves the permanent, so the copy is what arrives, and the arrivals pass installs the
 * copied card's statics and raises the copied card's entry trigger.
 */
export function becomeCopyOf(
  state: GameState, id: string, copying: string,
  /**
   * The copy's exceptions (D594): "except it's a Shapeshifter Rogue in addition to its other types",
   * "except it isn't legendary", "except it has flying". Built from the copied card's definition, so
   * it is a function of it rather than a fixed profile. The exceptions are part of the copy's
   * copiable values (CR 707.9b), which is what registering them as a definition makes them: a Clone
   * of this permanent copies the exceptions too.
   */
  except?: (copied: CardDef) => TokenCopyProfile,
): GameState {
  const self = state.instances[id];
  const other = state.instances[copying];
  if (self === undefined || other === undefined) return state;
  const copied = state.cardDefs[other.defKey];
  if (copied === undefined) return state;
  let next = state;
  let key = other.defKey;
  if (except !== undefined) {
    const profile = except(copied);
    key = profileKey(copied, profile);
    if (next.cardDefs[key] === undefined) {
      next = { ...next, cardDefs: { ...next.cardDefs, [key]: withProfile(copied, profile) } };
    }
  }
  return withInstance(next, id, {
    defKey: key,
    printedDefKey: self.printedDefKey ?? self.defKey,
  });
}

/**
 * "Transform it" — turn a permanent over to its other face (CR 701.28).
 *
 * The same one-field move as `becomeCopyOf` and as the modal land `playLand` puts down, and that
 * is the whole implementation: `defKey` is what every reader downstream looks a face up through, so
 * pointing it at the other face makes a 1/1 Human Wizard into a 3/2 flying Insect for
 * characteristics, for the script registry, for combat, for the bot and for the table, none of
 * which has to learn that cards have backs. `printedDefKey` remembers the front face, and
 * `relocate` already puts it back on the way off the battlefield (CR 712.4a).
 *
 * **Symmetric, because the rules word it that way**: transform turns over whichever face is up, so
 * a permanent already showing its back goes back to its front. Nothing in this pool transforms
 * twice, and writing the half that is used and leaving the other to a future caller is how a wrong
 * one-way assumption gets built in.
 *
 * Refused everywhere but the battlefield, which is the rule rather than a guard: a card in a hand
 * or a graveyard has no face turned up to turn over (CR 712.3), and a *spell* on the stack is its
 * front face until it resolves.
 *
 * The flip is **recorded rather than announced** — `GameState.transformed`, drained by `settle`,
 * which is what makes "when this creature transforms into Awoken Horror" an ordinary triggered
 * ability. This function lives below the module that can `raise`, exactly as `copySpellOnStack`
 * does, and the family exists so that a caller cannot forget.
 *
 * Not built, and said rather than discovered: a permanent that is **both** a copy and transformed.
 * `printedDefKey` holds one memory and the two mechanics want it for different things, so a Clone
 * of a Delver could not go back to being a Clone. Nothing in the pool is one; a card that needs it
 * should give the instance a second field with a test, rather than find out.
 */
export function transformPermanent(
  state: GameState, id: string,
  /**
   * False for a permanent that **enters** transformed (D593): a daybound card arriving at night
   * shows its back face from the start and never transformed (CR 712.14), so nothing that watches
   * "transforms into" may see it.
   */
  record = true,
): GameState {
  const self = state.instances[id];
  if (self === undefined || self.zone !== 'battlefield') return state;
  const noted = record ? recordTransform(state, id) : state;
  const printed = self.printedDefKey;
  /*
    Already turned over, so this turns it back: the front face is in `printedDefKey` and clearing
    the field is what says "this permanent is the card it is printed as" again.
  */
  if (printed !== undefined) {
    return withInstance(noted, id, { defKey: printed, printedDefKey: undefined });
  }
  // Only a transforming card has a back to turn to (CR 701.28c): a flip card flips, it does not
  // transform, and an adventurer or a prepare card has a spell beside it, not a back (D982).
  if (state.cardDefs[self.defKey]?.faces?.kind !== 'transform') return state;
  const back = facesOf(state.cardDefs[self.defKey])[0];
  if (back === undefined) return state;
  const backKey = defKeyFor(back);
  if (state.cardDefs[backKey] === undefined) return state;
  return withInstance(noted, id, { defKey: backKey, printedDefKey: self.defKey });
}

/**
 * "Flip it" (D982, CR 701.29): a flip card turns to its other half, for as long as it stays on the
 * battlefield. One way: a flipped permanent cannot flip again (CR 701.29c), so a second flip does
 * nothing. The same one-field move as transform, `printedDefKey` remembering the upright half and
 * `relocate` putting it back on the way off — and announced as nothing, because flipping is not
 * transforming and "whenever this creature transforms" must not hear it.
 */
export function flipPermanent(state: GameState, id: string): GameState {
  const self = state.instances[id];
  if (self === undefined || self.zone !== 'battlefield' || self.printedDefKey !== undefined) return state;
  const def = state.cardDefs[self.defKey];
  if (def?.faces?.kind !== 'flip') return state;
  const flipped = def.faces.cards[0];
  if (flipped === undefined || state.cardDefs[defKeyFor(flipped)] === undefined) return state;
  return withInstance(state, id, { defKey: defKeyFor(flipped), printedDefKey: self.defKey });
}

/*
  ── Day and night (D593) ──────────────────────────────────────────────────────────────────────

  CR 726 and the two keywords that read it, daybound and nightbound (CR 702.145). Three rules, and
  each is one function here:

  - **It becomes day** the first time a permanent with daybound is on the battlefield and it is
    neither, and **night** for a nightbound one (CR 702.145d, 702.145g): `establishDayNight`.
  - **It changes as a turn begins** (CR 726.3a): day becomes night if the previous turn's active
    player cast no spells that turn, and night becomes day if they cast two or more. The active
    player's count only — not the table's, which is the werewolves' older rule and a different one.
    `dayNightAfter`.
  - **Permanents follow it** (CR 702.145c, 702.145f): at night a daybound permanent shows its back
    face, by day a nightbound one shows its front. Turning one over this way **is** a transform, so
    "transforms into" sees it — but a permanent that arrives already matching the time of day enters
    transformed and does not (CR 712.14), which is `record` on `transformPermanent`.
    `matchDayNight`.

  Read off live characteristics, as every keyword is: a daybound creature that has lost all its
  abilities does not turn over, which is the rule.
*/

/** Whether this permanent has the keyword, as it is now. */
const bound = (state: GameState, id: string, keyword: 'daybound' | 'nightbound'): boolean => {
  const inst = state.instances[id];
  return inst !== undefined && inst.zone === 'battlefield'
    && characteristicsOf(state, inst).keywords.has(keyword);
};

/** Turns every permanent on the battlefield (or only `only`) to the face the time of day wants. */
export function matchDayNight(state: GameState, record: boolean, only?: readonly string[]): GameState {
  const time = state.dayNight ?? null;
  if (time === null) return state;
  const wrong = time === 'night' ? 'daybound' : 'nightbound';
  let next = state;
  for (const id of only ?? Object.keys(state.instances)) {
    if (bound(next, id, wrong)) next = transformPermanent(next, id, record);
  }
  return next;
}

/** CR 702.145d/g: neither day nor night, and a bound permanent appears. */
export function establishDayNight(state: GameState): GameState {
  if ((state.dayNight ?? null) !== null) return state;
  const ids = Object.keys(state.instances);
  const time = ids.some((id) => bound(state, id, 'daybound')) ? 'day'
    : ids.some((id) => bound(state, id, 'nightbound')) ? 'night' : null;
  return time === null ? state : matchDayNight({ ...state, dayNight: time }, true);
}

/**
 * CR 726.3a, as a turn begins: what the time of day becomes, given the turn that just ended.
 *
 * `previous` is that turn's active player; `spellsCastLastTurnBy` is already that turn's tally,
 * because the cleanup step that ends a turn keeps it (D592). Neither stays neither.
 */
export function dayNightAfter(state: GameState, previous: SeatIndex): GameState {
  const time = state.dayNight ?? null;
  if (time === null) return state;
  const cast = (state.spellsCastLastTurnBy ?? {})[String(previous)] ?? 0;
  const now = time === 'day' && cast === 0 ? 'night' : time === 'night' && cast >= 2 ? 'day' : time;
  return now === time ? state : matchDayNight({ ...state, dayNight: now }, true);
}

/**
 * Pairs two creatures for **soulbond** (CR 702.95a), writing the fact on both.
 *
 * Both, because a pair is symmetric and exclusive: either member's `pairedWith` has to be enough
 * to find the other, or every reader needs to know which of the two carried the keyword. The
 * static that grants the pair its bonus is `scope: 'pair'` on the soulbonded creature, and it
 * reads `source.pairedWith` — so this one write is what turns the ability on.
 *
 * Refuses rather than overwrites when either card is already paired, is not on the battlefield, or
 * is the same card as the other: "another **unpaired** creature you control" is the whole
 * restriction, and a pairing made in spite of it would leave an orphaned half behind.
 */
export const pairCreatures = (state: GameState, a: string, b: string): GameState => {
  const first = state.instances[a];
  const second = state.instances[b];
  if (a === b || first === undefined || second === undefined) return state;
  if (first.zone !== 'battlefield' || second.zone !== 'battlefield') return state;
  if (first.pairedWith !== undefined || second.pairedWith !== undefined) return state;
  return withInstance(withInstance(state, a, { pairedWith: b }), b, { pairedWith: a });
};

/**
 * Breaks every pair whose two members are no longer two creatures one player controls
 * (CR 702.95b), as a state-based action.
 *
 * A pass over the board rather than a hook on each of the ways a pair can end, which is the same
 * choice the rest of `stateBasedActions` makes and for the same reason: the list of ways is longer
 * than it looks. A member can die, be exiled, be bounced, stop being a creature because an effect
 * set its type, or change controller — and the last of those moves nothing and raises nothing, so
 * a hook-based version would miss it in exactly the case the rules spell out.
 *
 * `relocate` also clears the field on a zone change, which is not a duplicate of this: it keeps a
 * pointer into the graveyard from ever existing between the move and the next check.
 */
export const breakEndedPairs = (state: GameState): GameState => {
  let next = state;
  for (const [id, inst] of Object.entries(state.instances)) {
    const other = inst.pairedWith;
    if (other === undefined) continue;
    const partner = next.instances[other];
    const stillPaired = partner !== undefined
      && partner.pairedWith === id
      && inst.zone === 'battlefield' && partner.zone === 'battlefield'
      && inst.zoneSeat === partner.zoneSeat
      && characteristicsOf(next, inst).isCreature
      && characteristicsOf(next, partner).isCreature;
    if (stillPaired) continue;
    next = withInstance(next, id, { pairedWith: undefined });
    if (partner !== undefined) next = withInstance(next, other, { pairedWith: undefined });
  }
  return next;
};

/**
 * A clock that ran out, written down for the **log** rather than for `raise`.
 *
 * Called by the four things that spend a counter to nothing: vanishing, fading, suspend and Thing in
 * the Ice. See `GameState.expired` for why this is recorded at all and why it is not an event.
 *
 * Automated tables only, like the rest of the family: a table in manual mode has no clock ticking.
 */
export const recordExpiry = (state: GameState, card: string, counter: string): GameState => (
  state.automated
    ? {
      ...state,
      expired: [...(state.expired ?? []), {
        card,
        counter,
        // Read now rather than at drain time: see `ExpiredClock.name`.
        name: state.cardDefs[state.instances[card]?.defKey ?? '']?.name ?? 'a permanent',
      }],
    }
    : state);

/** The flip, written down for `settle` to raise. Automated tables only, like the rest of the family. */
const recordTransform = (state: GameState, id: string): GameState => (state.automated
  ? { ...state, transformed: [...(state.transformed ?? []), id] }
  : state);

/**
 * `keyOverride` decides where the definition is registered, for a copy whose characteristics are
 * not the copied card's — see `TokenCopyProfile`. Every other caller hands over a definition whose
 * name is its own, and for those the key is that name.
 */
export function createToken(
  state: GameState, seat: SeatIndex, card: CardDef, count = 1, keyOverride?: string,
): GameState {
  return addTokens(state, seat, card, count, keyOverride).state;
}

/** "Create a tapped … token" (D740): the tokens arrive tapped, never untapped in between. */
export function createTappedTokens(state: GameState, seat: SeatIndex, card: CardDef, count = 1): GameState {
  const made = addTokens(state, seat, card, count);
  return made.created.reduce((next, id) => withInstance(next, id, { tapped: true }), made.state);
}

/**
 * `createToken`, and the ids of what it made.
 *
 * Every caller but one wants the state and nothing else, which is why `createToken` is the shape
 * this module exports and this is the shape underneath it. **Myriad** is the one: it has to put
 * each token it creates into combat against a particular player and then remember it to exile at
 * end of combat, and neither of those is possible from a `GameState` that has merely grown some
 * permanents. Diffing the battlefield before and after would be the alternative, and it would be
 * wrong the first time a token's arrival makes another one.
 */
export function addTokens(
  state: GameState, seat: SeatIndex, card: CardDef, count = 1, keyOverride?: string,
): { readonly state: GameState; readonly created: readonly string[] } {
  const def = normaliseDef(card);
  /*
    Two tokens can share a name and differ (D810): Wurmcoil Engine makes a "Phyrexian Wurm" with
    deathtouch and a "Phyrexian Wurm" with lifelink. Keyed by name alone the second arrived as the
    first, so a name already holding a different definition gets a key of its own; an identical one
    (every Treasure) keeps sharing.
  */
  const named = keyOverride ?? defKeyFor(def);
  const existing = state.cardDefs[named];
  const sameDef = (a: CardDef, b: CardDef): boolean => JSON.stringify(a) === JSON.stringify(b);
  let key = named;
  if (keyOverride === undefined && existing !== undefined && !sameDef(existing, def)) {
    let n = 2;
    while (state.cardDefs[`${named}#${n}`] !== undefined && !sameDef(state.cardDefs[`${named}#${n}`]!, def)) n += 1;
    key = `${named}#${n}`;
  }
  const cardDefs = { ...state.cardDefs, [key]: state.cardDefs[key] ?? def };
  const instances = { ...state.instances };
  let seq = state.instanceSeq;
  const created: string[] = [];
  // Doubled for each Parallel Lives the creating seat controls (D652).
  // And one more Treasure for each Xorn (D866), before the doubling.
  const plus = count > 0 && def.name === 'Treasure' ? treasureBonus(state, seat) : 0;
  const made = (Math.max(0, count) + plus) * tokenMultiplier(state, seat);
  for (let i = 0; i < made; i++) {
    seq += 1;
    const id = `t${seat}_${seq}`;
    instances[id] = {
      id, defKey: key, owner: seat, zoneSeat: seat, zone: 'battlefield',
      tapped: false, faceDown: false, revealed: false, counters: {}, attachedTo: null,
      isToken: true, isCommander: false, damage: 0, enteredTurn: state.turn,
    };
    created.push(id);
  }
  const bf = zoneKey(seat, 'battlefield');
  // A token enters the battlefield like anything else, and its entry is recorded for `settle` to
  // announce. Without this a token triggered nothing at all — not its own ability, and not an
  // Impact Tremors watching for it. `createToken` writes the zone directly rather than going
  // through `relocate`, which is why it has to say so here.
  const entered = state.automated ? [...state.entered, ...created] : state.entered;
  // "If you created a token this turn" (D1084): counted for the seat that created them.
  const tokenTally = state.tokensCreatedThisTurn ?? {};
  const tokensCreatedThisTurn = created.length === 0 ? state.tokensCreatedThisTurn
    : { ...tokenTally, [String(seat)]: (tokenTally[String(seat)] ?? 0) + created.length };
  return {
    state: withZones({ ...state, cardDefs, instances, instanceSeq: seq, entered, ...(tokensCreatedThisTurn === undefined ? {} : { tokensCreatedThisTurn }) }, {
      [bf]: [...listAt(state, bf), ...created],
    }),
    created,
  };
}

/**
 * A **copy of a card**, made in exile under `seat` to be cast (D936, CR 707.12): "cast a copy of
 * the encoded card without paying its mana cost". Its owner is the seat that will cast it, and it
 * is `cardCopy`, so it ceases to exist as it moves anywhere but the stack (see `relocate`): once
 * it has resolved, and when the offer is declined and the offer's disposition moves it.
 */
export function copyCardInExile(
  state: GameState, card: string, seat: SeatIndex,
): { readonly state: GameState; readonly id: string | null } {
  const original = state.instances[card];
  if (original === undefined) return { state, id: null };
  const seq = state.instanceSeq + 1;
  const id = `c${seat}_${seq}`;
  const exile = zoneKey(seat, 'exile');
  const instances = {
    ...state.instances,
    [id]: {
      id, defKey: original.defKey, owner: seat, zoneSeat: seat, zone: 'exile' as const,
      tapped: false, faceDown: false, revealed: true, counters: {}, attachedTo: null,
      isToken: false, isCommander: false, damage: 0, enteredTurn: state.turn, cardCopy: true as const,
    },
  };
  return { state: withZones({ ...state, instances, instanceSeq: seq }, { [exile]: [...listAt(state, exile), id] }), id };
}

/**
 * The copy a prepared permanent's controller casts (D978): "While it's prepared, you may cast a
 * copy of its spell. Doing so unprepares it."
 *
 * Made in its controller's exile as a copy of the **spell face** alone, with the D583 permission to
 * cast it this turn, and the permanent unprepared in the same step — so the cast that follows is an
 * ordinary cast out of exile at the spell's own cost and timing, and a copy that is cast and resolves
 * leaves the game the way any copy of a card does (CR 707.12). `null` when there is nothing to copy:
 * the permanent is gone, is not prepared, is not this seat's, or its card has no prepare face.
 *
 * Both `legalActions` and `castSpell` call this on the same state, which is why the offer and the
 * cast agree on the copy's id and on everything the spell would see.
 */
export function preparedCopyOf(
  state: GameState, permanent: string, seat: SeatIndex,
): { readonly state: GameState; readonly id: string } | null {
  const source = state.instances[permanent];
  if (source === undefined || source.zone !== 'battlefield' || source.zoneSeat !== seat || source.prepared !== true) {
    return null;
  }
  const def = state.cardDefs[source.printedDefKey ?? source.defKey];
  const spell = def?.faces?.kind === 'prepare' ? def.faces.cards[0] : undefined;
  if (spell === undefined || state.cardDefs[defKeyFor(spell)] === undefined) return null;
  const seq = state.instanceSeq + 1;
  const id = `c${seat}_${seq}`;
  const exile = zoneKey(seat, 'exile');
  const { prepared: _spent, ...unprepared } = source;
  const instances = {
    ...state.instances,
    [permanent]: unprepared,
    [id]: {
      id, defKey: defKeyFor(spell), owner: seat, zoneSeat: seat, zone: 'exile' as const,
      tapped: false, faceDown: false, revealed: true, counters: {}, attachedTo: null,
      isToken: false, isCommander: false, damage: 0, enteredTurn: state.turn, cardCopy: true as const,
      playFromExile: { by: seat, grantedTurn: state.turn, through: 'this-turn' as const },
    },
  };
  return { state: withZones({ ...state, instances, instanceSeq: seq }, { [exile]: [...listAt(state, exile), id] }), id };
}

/**
 * Moves a permanent to another player's battlefield, which is what gaining control is.
 *
 * And marks an echo as owed again (CR 702.29b), because echo is about **control** and not about
 * entering: a creature with echo stolen by a Mind Control owes its echo to its new controller in
 * their next upkeep, and a control change is not an arrival — `relocate` from one battlefield to
 * another records no entry, which is right, so the arrivals pass never sees this.
 *
 * Set without asking whether the card has echo, because asking would mean reading its script and
 * this module sits below the one that holds them. A flag on a permanent with no echo trigger is
 * inert: the only thing in the game that reads `echoDue` is an echo trigger's own condition.
 */
/**
 * "Exchange control of A and B" (D1248, CR 701.12): each goes to the other's controller, for good.
 * Nothing happens unless both are still on the battlefield under different controllers
 * (CR 701.12b): an exchange of two of the same player's permanents changes nothing.
 */
export function exchangeControl(state: GameState, a: string, b: string): GameState {
  const first = state.instances[a];
  const second = state.instances[b];
  if (first === undefined || second === undefined || first.zone !== 'battlefield' || second.zone !== 'battlefield') return state;
  if (first.zoneSeat === second.zoneSeat) return state;
  const toSecond = second.zoneSeat;
  const toFirst = first.zoneSeat;
  return gainControl(gainControl(state, a, toSecond), b, toFirst);
}

export function gainControl(state: GameState, id: string, seat: SeatIndex): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  return withInstance(relocate(state, inst, 'battlefield', seat, 'bottom'), id, { echoDue: true });
}

/**
 * Whether a "for as long as" control change still holds (D1040): its source on the battlefield,
 * and, as its terms ask, still controlled by `controller` and still tapped. A phased-out source is
 * not on the battlefield, so its control change ends too (CR 702.26b).
 */
export function controlTermsHold(
  state: GameState, source: string, controller: SeatIndex,
  terms: { readonly controlled?: boolean; readonly tapped?: boolean },
): boolean {
  const from = state.instances[source];
  if (from === undefined || from.zone !== 'battlefield') return false;
  if (terms.controlled === true && from.zoneSeat !== controller) return false;
  return terms.tapped !== true || from.tapped;
}

/**
 * "Gain control of target creature for as long as you control ~ / ~ remains on the battlefield /
 * ~ remains tapped" (D1040): Sower of Temptation, Vedalken Shackles, Dragonlord Silumgar.
 *
 * The control move, and a `permanent` effect with `controlRevertTo` and the terms, which
 * `auraControl` keeps true of the board the way it keeps a control Aura's (D938): the newest
 * change on a permanent holds it, and when the terms fail the permanent goes back. If the terms
 * are already false as it resolves — the Sower bounced in response — the duration ended before it
 * began and nothing changes hands (CR 611.2b).
 */
export function stealWhile(
  state: GameState, id: string, controller: SeatIndex, source: string,
  terms: { readonly controlled?: boolean; readonly tapped?: boolean },
): GameState {
  const target = state.instances[id];
  if (target === undefined || target.zone !== 'battlefield') return state;
  if (!controlTermsHold(state, source, controller, terms)) return state;
  const from = target.zoneSeat;
  const next = from === controller ? state : gainControl(state, id, controller);
  const seq = next.autoSeq + 1;
  return {
    ...next,
    autoSeq: seq,
    effects: [...next.effects, {
      id: `fx${seq}`, source, controller, scope: { kind: 'cards', ids: [id] }, duration: 'permanent',
      createdTurn: next.turn, controlRevertTo: from, controlWhile: terms,
    }],
  };
}

/**
 * "Gain control of target creature until end of turn. Untap that creature. It gains haste until end
 * of turn." — the Act of Treason sentence, as one function (D516).
 *
 * All three printed clauses, because all three are one play: without the untap a tapped creature is
 * stolen and does nothing, and without the haste it is summoning-sick for its new controller
 * (CR 302.6) — the whole point of the card is attacking with it this turn. The control change is
 * `duration: 'end-of-turn'` with `controlRevertTo` recording whose it was, which `endTurnCleanup`
 * reads on expiry.
 *
 * **One function because there are two callers.** The pool's hand-written Act of Treason did this
 * inline, and the compiler now reads the same sentence off 15 legal printings — Limits of Solidarity,
 * Malevolent Whispers, Bloody Betrayal and the rest. Two copies of a control change that has to
 * revert is the shape this engine keeps removing (D441, D438, D465): the one that reverts correctly
 * and the one somebody will edit.
 *
 * `extra` is the pump the variants add on top — Malevolent Whispers prints "+2/+0 and gains haste",
 * so the haste and the size arrive as one continuous effect rather than two.
 */
export function stealUntilEndOfTurn(
  state: GameState, id: string, controller: SeatIndex, source: string, extra: PumpOptions = {},
): GameState {
  const original = state.instances[id]?.zoneSeat;
  if (original === undefined) return state;
  let next = gainControl(state, id, controller);
  next = tap(next, id, false);
  next = pump(next, [id], source, controller, {
    ...extra,
    keywords: [...new Set(['haste' as const, ...(extra.keywords ?? [])])],
    duration: 'end-of-turn',
  });
  const seq = next.autoSeq + 1;
  return {
    ...next,
    autoSeq: seq,
    effects: [...next.effects, {
      id: `fx${seq}`,
      source,
      controller,
      scope: { kind: 'cards', ids: [id] },
      duration: 'end-of-turn',
      createdTurn: next.turn,
      controlRevertTo: original,
    }],
  };
}

/**
 * An Aura already on the battlefield moved onto another permanent (D3015, Felidar Umbra's "Attach ~ to
 * target creature you control"). What it grants was installed as it resolved, scoped to the
 * creature it enchanted (`addAuraEffect`), so every effect from this Aura scoped to the old host is
 * re-pointed at the new one, its conditional parts with it. Effects scoped to anything else, its
 * own statics included, stay where they are.
 */
export function moveAura(state: GameState, auraId: string, hostId: string): GameState {
  const aura = state.instances[auraId];
  const host = state.instances[hostId];
  if (aura === undefined || host === undefined || host.zone !== 'battlefield') return state;
  const old = aura.attachedTo;
  if (old === hostId) return state;
  const effects = old === null ? state.effects : state.effects.map((e) => (
    e.source === auraId && e.scope.kind === 'cards' && e.scope.ids.includes(old)
      ? { ...e, scope: { ...e.scope, ids: e.scope.ids.map((id) => (id === old ? hostId : id)) } }
      : e));
  return withInstance({ ...state, effects }, auraId, { attachedTo: hostId });
}

export function attachTo(state: GameState, auraId: string, hostId: string): GameState {
  const aura = state.instances[auraId];
  const host = state.instances[hostId];
  if (aura === undefined || host === undefined || host.zone !== 'battlefield') return state;
  return withInstance(state, auraId, { attachedTo: hostId });
}

/**
 * Equip: move an Equipment onto a creature its controller controls, bonus and all.
 *
 * Different from an Aura in the two ways that matter. It *moves* — equipping again takes it off
 * the creature it was on, so the old bonus has to go with it, which is what `removeEffectsFrom`
 * is doing here. And it **stays on the battlefield** when that creature dies; only the attachment
 * ends (CR 301.5c), which is handled by the state-based actions rather than here.
 */
export function equipTo(
  state: GameState, equipId: string, hostId: string, controller: SeatIndex, bonus: PumpOptions,
): GameState {
  const equipment = state.instances[equipId];
  const host = state.instances[hostId];
  if (equipment === undefined || host === undefined || host.zone !== 'battlefield') return state;
  if (host.zoneSeat !== controller) return state;
  // Protection from a colour stops an Equipment of that colour attaching (CR 702.16e). Almost
  // every Equipment is colourless and gets straight past it, which is the point of checking rather
  // than assuming: the one that is not would otherwise attach and nobody would notice.
  if (protectedFrom(state, hostId, equipId)) return state;
  const moved = withInstance(removeEffectsFrom(state, equipId), equipId, { attachedTo: hostId });
  return staticEffect(moved, equipId, controller, { kind: 'cards', ids: [hostId] }, bonus);
}

// ── Continuous effects ───────────────────────────────────────────────────────────────────────────

export interface PumpOptions {
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly Keyword[];
  readonly removeKeywords?: readonly Keyword[];
  readonly cantAttack?: boolean;
  readonly cantBlock?: boolean;
  /** See `ContinuousEffect.doesntUntap` (D589). */
  readonly doesntUntap?: boolean;
  /** See `ContinuousEffect.preventsCombatDamage`. A Fog Bank is this, printed on a 0/2. */
  readonly preventsCombatDamage?: boolean;
  /** See `ContinuousEffect.assignsNoCombatDamage`: the creature deals none, and may still be hit. */
  readonly assignsNoCombatDamage?: boolean;
  /**
   * The D738 prevention flags as a static or an attachment carries them (D752): Muzzle ("by
   * enchanted creature"), Dawn Elemental ("to ~"), Inner Sanctum ("to creatures you control").
   */
  readonly preventsDamageTo?: true;
  readonly preventsDamageFrom?: true;
  /** See `ContinuousEffect.preventsDamageBy` (D1218). */
  readonly preventsDamageBy?: ContinuousEffect['preventsDamageBy'];
  readonly preventsCombatOnly?: true;
  readonly preventsNoncombatOnly?: true;
  readonly preventsDamageToPlayers?: 'controller' | 'all';
  /** See `ContinuousEffect.exiledInsteadOfDying` — "exile it instead" (D539). */
  readonly exiledInsteadOfDying?: boolean;
  /** See `ContinuousEffect.mustAttack` — "attacks each combat if able" (CR 508.1d). */
  readonly mustAttack?: boolean;
  /** See `ContinuousEffect.mustBlock` — the blocking requirements (CR 509.1c, D913). */
  readonly mustBlock?: boolean;
  readonly mustBlockAttacker?: string;
  /** See `ContinuousEffect.cantBlockAttacker` (D1323). */
  readonly cantBlockAttacker?: string;
  readonly mustBeBlocked?: boolean;
  readonly lure?: boolean;
  /** See `ContinuousEffect.blockedByOne` (D937). */
  readonly blockedByOne?: boolean;
  /** See `ContinuousEffect.assignsAsUnblocked` (D772). */
  readonly assignsAsUnblocked?: boolean;
  /** See `ContinuousEffect.assignsByToughness` (D1318). */
  readonly assignsByToughness?: boolean;
  /** See `ContinuousEffect.cantActivate` (D943). */
  readonly cantActivate?: boolean;
  /** See `ContinuousEffect.cantActivateNonMana` (D944). */
  readonly cantActivateNonMana?: boolean;
  /** See `ContinuousEffect.cantBeBlockedByWalls`. */
  readonly cantBeBlockedByWalls?: boolean;
  /** See `ContinuousEffect.cantBeBlocked`. */
  readonly cantBeBlocked?: boolean;
  /** See `ContinuousEffect.landwalk`: the land subtypes, e.g. `['Island']` for islandwalk. */
  readonly landwalk?: readonly string[];
  /** See `ContinuousEffect.mustAttackAnotherPlayer` — goad's second half (CR 701.38a). */
  readonly mustAttackAnotherPlayer?: boolean;
  /** See `ContinuousEffect.protectionFrom` — protection from a colour (CR 702.16). */
  readonly protectionFrom?: readonly Color[];
  /** See `ContinuousEffect.protectionSparesSource` (D1189). */
  readonly protectionSparesSource?: true;
  /** See `ContinuousEffect.protectionFromChosen` (D1190). */
  readonly protectionFromChosen?: true;
  /** See `ContinuousEffect.protectionOutsideIdentity` (D849). */
  readonly protectionOutsideIdentity?: true;
  /** See `ContinuousEffect.setPower` — layer 7b, "becomes 1/1" rather than "gets +1/+1". */
  readonly setPower?: number;
  /** See `ContinuousEffect.switchPowerToughness` (D1211) — layer 7d. */
  readonly switchPowerToughness?: true;
  readonly setToughness?: number;
  /** See `ContinuousEffect.losesAllAbilities` — layer 6. */
  readonly losesAllAbilities?: boolean;
  /** See `ContinuousEffect.addTypes` — layer 4, "becomes a creature". */
  readonly addTypes?: readonly string[];
  /** See `ContinuousEffect.removeTypes` — layer 4, "isn't a creature" (D657). */
  readonly removeTypes?: readonly string[];
  readonly addSubtypes?: readonly string[];
  /** See `ContinuousEffect.setCreatureTypes` — "becomes a Frog". */
  readonly setCreatureTypes?: readonly string[];
  /** See `ContinuousEffect.setLandTypes` — "Enchanted land is an Island" (D1246). */
  readonly setLandTypes?: readonly string[];
  /** See `ContinuousEffect.allCreatureTypes` — "with all creature types". */
  readonly allCreatureTypes?: boolean;
  /** See `ContinuousEffect.setColors` — layer 5, "becomes red". */
  readonly setColors?: readonly Color[];
  /** See `ContinuousEffect.definesSize` — layer 7a, a size that is a count of the board. */
  readonly definesSize?: ContinuousEffect['definesSize'];
  /** See `ContinuousEffect.sizePerCount` — layer 7c, a rate times a live count of the board. */
  readonly sizePerCount?: ContinuousEffect['sizePerCount'];
  /** See `ContinuousEffect.while` — metalcraft, and any other "as long as" clause. */
  readonly while?: ContinuousEffect['while'];
  /**
   * See `ContinuousEffect.grants`: which of the granting card's `grantedTriggers` the creatures in
   * scope are handed.
   *
   * Here rather than in a declaration of its own so that **every** builder carries it for nothing.
   * `modsFrom` is the one translation from "what a card says" to "what an effect holds", and the
   * five builders that read it are an Aura's bonus, a bestowed one, an Equipment's, a static and
   * soulbond's pair — which happens to be the complete list of ways a printed card grants an
   * ability. Adding a second declaration would have meant teaching each of those about it
   * separately, which is the bug this function's own docblock is about.
   */
  readonly grants?: readonly number[];
  /**
   * See `ContinuousEffect.grantsAbilities`: which of the granting card's `grantedAbilities` the
   * permanents in scope are handed. Here for the reason `grants` is — one translation, every
   * builder carries it for nothing.
   */
  readonly grantsAbilities?: readonly number[];
  /** See `ContinuousEffect.encodedCard` (cipher, D936). */
  readonly encodedCard?: string;
  /** See `ContinuousEffect.onlyAttacking` (D941). */
  readonly onlyAttacking?: true;
  /** See `ContinuousEffect.onlyNontoken` (D871). */
  readonly onlyNontoken?: true;
  /** See `ContinuousEffect.onlyTokens` (D873). */
  readonly onlyTokens?: true;
  readonly onlyWithCounter?: string;
  /** See `ContinuousEffect.onlyWithKeyword` (D1126). */
  readonly onlyWithKeyword?: Keyword;
  /** See `ContinuousEffect.onlyKind` (D735). */
  readonly onlyKind?: readonly CreatureKindWord[];
  /** See `ContinuousEffect.onlySubtypes` / `onlyColours` (D814). */
  readonly onlySubtypes?: readonly string[];
  readonly onlyColours?: readonly Color[];
  /** See `ContinuousEffect.notSubtypes` (D828). */
  readonly notSubtypes?: readonly string[];
  /**
   * Further effects from the same source on the same scope, each with its own filters (D814): an
   * attachment's "As long as enchanted creature is red, it gets +1/+1" beside its plain bonus.
   * Pushed by `staticEffect` and by the Aura's attach, and by nothing that makes a temporary pump.
   */
  readonly alsoParts?: readonly PumpOptions[];
  readonly duration?: EffectDuration;
}

/**
 * One translation from "what a card says" to "what an effect carries", for every builder there is.
 *
 * Each of them used to copy the subset of `PumpOptions` it happened to know about — five
 * near-identical lists that quietly disagreed. `pump` dropped `mustAttack`; `staticEffect` dropped
 * that *and* `preventsCombatDamage`, which is the path an Equipment's bonus takes; `pumpTeam` and
 * `pumpAll` carried only a body and keywords; the aura builder dropped four; and the statics
 * builder dropped `cantAttack` and `cantBlock`, so a card whose printed static was "this creature
 * can't attack" would have done nothing at all. A flag therefore worked or vanished depending on
 * which builder a script happened to reach for, with nothing anywhere to say so.
 *
 * One list, read by everything, is the only version of this that stays true — and it is the same
 * move as `manaSources` serving both `legalActions` and payment: one answer to one question.
 *
 * `duration` is not here on purpose: each builder decides its own, and a static effect that
 * accepted one would be a static effect that is not static.
 */
export function modsFrom(opts: PumpOptions): Omit<ContinuousEffect, 'id' | 'createdTurn' | 'source' | 'controller' | 'scope' | 'duration'> {
  return {
    ...(opts.power === undefined ? {} : { power: opts.power }),
    ...(opts.toughness === undefined ? {} : { toughness: opts.toughness }),
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
    ...(opts.removeKeywords ? { removeKeywords: opts.removeKeywords } : {}),
    ...(opts.cantAttack ? { cantAttack: true } : {}),
    ...(opts.cantBlock ? { cantBlock: true } : {}),
    ...(opts.doesntUntap ? { doesntUntap: true } : {}),
    ...(opts.preventsCombatDamage ? { preventsCombatDamage: true } : {}),
    ...(opts.assignsNoCombatDamage ? { assignsNoCombatDamage: true } : {}),
    ...(opts.preventsDamageTo ? { preventsDamageTo: true as const } : {}),
    ...(opts.preventsDamageFrom ? { preventsDamageFrom: true as const } : {}),
    ...(opts.preventsDamageBy === undefined ? {} : { preventsDamageBy: opts.preventsDamageBy }),
    ...(opts.preventsCombatOnly ? { preventsCombatOnly: true as const } : {}),
    ...(opts.preventsNoncombatOnly ? { preventsNoncombatOnly: true as const } : {}),
    ...(opts.preventsDamageToPlayers === undefined ? {} : { preventsDamageToPlayers: opts.preventsDamageToPlayers }),
    ...(opts.exiledInsteadOfDying ? { exiledInsteadOfDying: true } : {}),
    ...(opts.mustAttack ? { mustAttack: true } : {}),
    ...(opts.mustBlock ? { mustBlock: true } : {}),
    ...(opts.mustBlockAttacker === undefined ? {} : { mustBlockAttacker: opts.mustBlockAttacker }),
    ...(opts.cantBlockAttacker === undefined ? {} : { cantBlockAttacker: opts.cantBlockAttacker }),
    ...(opts.mustBeBlocked ? { mustBeBlocked: true } : {}),
    ...(opts.lure ? { lure: true } : {}),
    ...(opts.blockedByOne ? { blockedByOne: true } : {}),
    ...(opts.assignsAsUnblocked ? { assignsAsUnblocked: true } : {}),
    ...(opts.assignsByToughness ? { assignsByToughness: true } : {}),
    ...(opts.cantActivate ? { cantActivate: true } : {}),
    ...(opts.cantActivateNonMana ? { cantActivateNonMana: true } : {}),
    ...(opts.cantBeBlockedByWalls ? { cantBeBlockedByWalls: true } : {}),
    ...(opts.cantBeBlocked ? { cantBeBlocked: true } : {}),
    ...(opts.landwalk === undefined ? {} : { landwalk: [...opts.landwalk] }),
    ...(opts.mustAttackAnotherPlayer ? { mustAttackAnotherPlayer: true } : {}),
    ...(opts.protectionFrom ? { protectionFrom: opts.protectionFrom } : {}),
    ...(opts.protectionSparesSource ? { protectionSparesSource: true as const } : {}),
    ...(opts.protectionFromChosen ? { protectionFromChosen: true as const } : {}),
    ...(opts.protectionOutsideIdentity ? { protectionOutsideIdentity: true as const } : {}),
    ...(opts.setPower === undefined ? {} : { setPower: opts.setPower }),
    ...(opts.setToughness === undefined ? {} : { setToughness: opts.setToughness }),
    ...(opts.switchPowerToughness ? { switchPowerToughness: true as const } : {}),
    ...(opts.losesAllAbilities ? { losesAllAbilities: true } : {}),
    ...(opts.addTypes ? { addTypes: opts.addTypes } : {}),
    ...(opts.removeTypes ? { removeTypes: opts.removeTypes } : {}),
    ...(opts.addSubtypes ? { addSubtypes: opts.addSubtypes } : {}),
    ...(opts.setCreatureTypes ? { setCreatureTypes: opts.setCreatureTypes } : {}),
    ...(opts.setLandTypes ? { setLandTypes: opts.setLandTypes } : {}),
    ...(opts.allCreatureTypes ? { allCreatureTypes: true } : {}),
    ...(opts.setColors ? { setColors: opts.setColors } : {}),
    ...(opts.definesSize ? { definesSize: opts.definesSize } : {}),
    ...(opts.sizePerCount ? { sizePerCount: opts.sizePerCount } : {}),
    ...(opts.while ? { while: opts.while } : {}),
    ...(opts.grants ? { grants: [...opts.grants] } : {}),
    ...(opts.grantsAbilities ? { grantsAbilities: [...opts.grantsAbilities] } : {}),
    ...(opts.encodedCard ? { encodedCard: opts.encodedCard } : {}),
    ...(opts.onlyAttacking ? { onlyAttacking: true as const } : {}),
    ...(opts.onlyNontoken ? { onlyNontoken: true as const } : {}),
    ...(opts.onlyTokens ? { onlyTokens: true as const } : {}),
    ...(opts.onlyWithCounter ? { onlyWithCounter: opts.onlyWithCounter } : {}),
    ...(opts.onlyWithKeyword ? { onlyWithKeyword: opts.onlyWithKeyword } : {}),
    ...(opts.onlyKind !== undefined && opts.onlyKind.length > 0 ? { onlyKind: [...opts.onlyKind] } : {}),
    ...(opts.onlySubtypes !== undefined && opts.onlySubtypes.length > 0 ? { onlySubtypes: [...opts.onlySubtypes] } : {}),
    ...(opts.onlyColours !== undefined && opts.onlyColours.length > 0 ? { onlyColours: [...opts.onlyColours] } : {}),
    ...(opts.notSubtypes !== undefined && opts.notSubtypes.length > 0 ? { notSubtypes: [...opts.notSubtypes] } : {}),
  };
}

function pushEffect(state: GameState, effect: Omit<ContinuousEffect, 'id' | 'createdTurn'>): GameState {
  const seq = state.autoSeq + 1;
  const full: ContinuousEffect = { ...effect, id: `fx${seq}`, createdTurn: state.turn };
  return { ...state, autoSeq: seq, effects: [...state.effects, full] };
}

/** "Take an extra turn after this one" (D1132, CR 500.7): `count` more turns owed to `seat`. */
export function grantExtraTurns(state: GameState, seat: SeatIndex, count: number): GameState {
  if (count <= 0 || state.seats[seat]?.eliminated !== false) return state;
  return { ...state, extraTurns: [...(state.extraTurns ?? []), ...Array.from({ length: count }, () => seat)] };
}

/** "Target creature gets +3/+3 until end of turn", and everything shaped like it. */
export function pump(
  state: GameState, ids: readonly string[], source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  if (ids.length === 0) return state;
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'cards', ids: [...ids] },
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/**
 * Goad: "until your next turn, that creature attacks each combat if able and attacks a player
 * other than you if able" (CR 701.38).
 *
 * Both halves and the duration, because all three are the card — a goad that wore off at end of
 * turn, or that forced an attack without sending it elsewhere, would be a different and much worse
 * card. `controller` is the goading player, and every part of the effect is read relative to them.
 */
/**
 * "You get an emblem with …" (D734, CR 114): an object in `seat`'s command zone whose abilities are
 * `text`, read like a card's. Recorded as an arrival so `settle` installs its statics; it raises no
 * enters trigger, because it is not a permanent and did not enter the battlefield.
 */
export function createEmblem(state: GameState, seat: SeatIndex, text: string, from: string, exactName?: string): GameState {
  const def = normaliseDef({
    name: exactName ?? `${from} emblem`, typeLine: 'Emblem', oracleText: text, manaCost: '', cmc: 0, colors: [],
  } as CardDef);
  const key = defKeyFor(def);
  const seq = state.instanceSeq + 1;
  const id = `e${seat}_${seq}`;
  const command = zoneKey(seat, 'command');
  return withZones({
    ...state,
    cardDefs: { ...state.cardDefs, [key]: state.cardDefs[key] ?? def },
    instances: {
      ...state.instances,
      [id]: {
        id, defKey: key, owner: seat, zoneSeat: seat, zone: 'command',
        tapped: false, faceDown: false, revealed: false, counters: {}, attachedTo: null,
        isToken: false, isCommander: false, damage: 0, enteredTurn: state.turn, emblem: true,
      },
    },
    instanceSeq: seq,
    entered: state.automated ? [...state.entered, id] : state.entered,
  }, { [command]: [...listAt(state, command), id] });
}

/**
 * The cards collect evidence N exiles (D1158, CR 701.59a): cards in the seat's graveyard whose mana
 * values total N or more, biggest first so the fewest leave, and any `later` says to keep (a
 * flashback or an escape of its own) only after the rest. Never `exclude`, the ability's own card.
 * `null` when the graveyard totals less, which is when evidence cannot be collected (CR 701.59b).
 */
export function evidencePlan(
  state: GameState, seat: SeatIndex, total: number, exclude: string | undefined,
  later: (id: string) => boolean = () => false,
): readonly string[] | null {
  const mv = (id: string): number => state.cardDefs[state.instances[id]?.defKey ?? '']?.cmc ?? 0;
  const ids = listAt(state, zoneKey(seat, 'graveyard')).filter((id) => id !== exclude && mv(id) > 0);
  const order = [...ids.filter((id) => !later(id)).sort((a, b) => mv(b) - mv(a)),
    ...ids.filter(later).sort((a, b) => mv(b) - mv(a))];
  const picked: string[] = [];
  let sum = 0;
  for (const id of order) {
    if (sum >= total) break;
    picked.push(id);
    sum += mv(id);
  }
  return sum >= total ? picked : null;
}

/** Collect evidence N as an effect (D1158): the board unchanged when it cannot be done. */
export function collectEvidence(state: GameState, seat: SeatIndex, total: number, exclude?: string): GameState {
  const plan = evidencePlan(state, seat, total, exclude);
  if (plan === null) return state;
  return plan.reduce((st, id) => {
    const card = st.instances[id];
    return card === undefined || card.zone !== 'graveyard' ? st : relocate(st, card, 'exile', card.owner, 'bottom');
  }, state);
}

/**
 * Incubate N (D1155, CR 701.53a): an Incubator token — a colorless artifact with "{2}: Transform this
 * artifact." — with N +1/+1 counters on it. The transformed face is a 0/0 Phyrexian artifact
 * creature (the `INCUBATOR` script), so the counters make it an N/N.
 */
export function incubate(state: GameState, seat: SeatIndex, n: number): GameState {
  const made = addTokens(state, seat, normaliseDef({
    name: 'Incubator', typeLine: 'Token Artifact — Incubator', oracleText: '{2}: Transform this artifact.',
    manaCost: '', cmc: 0, colors: [],
  } as CardDef), 1);
  return made.created.reduce((next, id) => (n > 0 ? addCounters(next, id, '+1/+1', n) : next), made.state);
}

/**
 * Manifest (D1153, CR 701.40a): the top card of the seat's library is put onto the battlefield face
 * down as a 2/2 creature with no text, name, subtypes or mana cost, marked `manifested` so it can be
 * turned face up for its mana cost if it is a creature card (`turnUpCostOf`). Nothing with an empty
 * library.
 */
export function manifestTop(state: GameState, seat: SeatIndex): GameState {
  const top = listAt(state, zoneKey(seat, 'library'))[0];
  const inst = top === undefined ? undefined : state.instances[top];
  if (inst === undefined) return state;
  let next = withInstance(state, inst.id, { faceDown: true });
  next = relocate(next, next.instances[inst.id]!, 'battlefield', seat, 'bottom');
  return withInstance(next, inst.id, { faceDown: true, manifested: true, tapped: false });
}

/**
 * Amass (D1150, CR 701.47a): "Amass Orcs 2" — if the seat controls no Army creature, it creates a
 * 0/0 black Orc Army creature token; then it chooses an Army creature it controls, puts that many
 * +1/+1 counters on it, and if it isn't an Orc it becomes one in addition to its other types. The
 * older "Amass 2" is Zombies (War of the Spark). With several Armies the largest is chosen, which is
 * the one a player nearly always wants grown; there is no question asked.
 */
export function amass(state: GameState, seat: SeatIndex, subtype: string, n: number): GameState {
  const armies = (st: GameState): string[] => listAt(st, zoneKey(seat, 'battlefield')).filter((id) => {
    const inst = st.instances[id];
    if (inst === undefined) return false;
    const ch = characteristicsOf(st, inst);
    return ch.isCreature && ch.typeLine.subtypes.includes('Army');
  });
  let next = state;
  if (armies(next).length === 0) {
    next = createToken(next, seat, normaliseDef({
      name: `${subtype} Army`, typeLine: `Token Creature — ${subtype} Army`, oracleText: '', manaCost: '', cmc: 0,
      colors: ['B'], power: '0', toughness: '0',
    } as CardDef));
  }
  const after = next;
  const power = (id: string): number => characteristicsOf(after, after.instances[id]!).power;
  const chosen = [...armies(after)].sort((a, b) => power(b) - power(a))[0];
  if (chosen === undefined) return next;
  next = addCounters(next, chosen, '+1/+1', n);
  if (!characteristicsOf(next, next.instances[chosen]!).typeLine.subtypes.includes(subtype)) {
    // Sourced at the Army itself: a `permanent` effect is removed when its source leaves
    // (`removeEffectsFrom`), and the amass spell leaves the stack at once.
    next = pump(next, [chosen], chosen, seat, { addSubtypes: [subtype], duration: 'permanent' });
  }
  return next;
}

/** The Ring emblem's text (D1144, CR 701.54a): shown to the players; `THE_RING`'s script runs it. */
const RING_TEXT = [
  'Your Ring-bearer is legendary and can\'t be blocked by creatures with greater power.',
  'Whenever your Ring-bearer attacks, draw a card, then discard a card.',
  'Whenever your Ring-bearer becomes blocked by a creature, that creature\'s controller sacrifices it at end of combat.',
  'Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.',
].join('\n');

/**
 * "The Ring tempts you" (D1144, CR 701.54a): the seat gets the Ring emblem if it has none, the Ring
 * gains its next ability (four at most), and `bearer` — a creature the seat controls, or `null` when
 * it controls none — becomes its Ring-bearer. Choosing the creature that already is one is allowed.
 * Each tempting counts, Ring-bearer or not, which is what "the Ring has tempted you N times" reads.
 */
export function temptWithRing(state: GameState, seat: SeatIndex, bearer: string | null): GameState {
  let next = state;
  if (!emblemsOf(next, seat).some((id) => next.cardDefs[next.instances[id]?.defKey ?? '']?.name === THE_RING)) {
    next = createEmblem(next, seat, RING_TEXT, THE_RING, THE_RING);
  }
  const was = next.ring?.[String(seat)];
  return {
    ...next,
    ring: { ...(next.ring ?? {}), [String(seat)]: { tempted: (was?.tempted ?? 0) + 1, bearer } },
  };
}

/** The Initiative's card (D1160, CR 722): held in the command zone of the seat that has it. */
export const THE_INITIATIVE = 'The Initiative';
export const INITIATIVE_TEXT = 'At the beginning of your upkeep, venture into Undercity.';
export const UNDERCITY = 'Undercity';

/** One room of a dungeon (CR 309.4): its name, its room ability's text, and the rooms below it. */
export interface DungeonRoom {
  readonly name: string;
  readonly text: string;
  readonly exits: readonly string[];
}

/**
 * The dungeons (D1160, D1163, CR 309.2), top room first: the three "venture into the dungeon"
 * chooses from, and Undercity, which the initiative uses.
 *
 * TODO(scryfall-dungeons): the room text is written from the printed card, because dungeons are
 * not legal cards and the local corpus has none; check it against the Scryfall import when that
 * can reach api.scryfall.com.
 */
export const LOST_MINE = 'Lost Mine of Phandelver';
export const MAD_MAGE = 'Dungeon of the Mad Mage';
export const TOMB = 'Tomb of Annihilation';
/** The dungeons "venture into the dungeon" may start (CR 309.3); Undercity only through the initiative. */
export const VENTURE_DUNGEONS: readonly string[] = [LOST_MINE, MAD_MAGE, TOMB];

export const DUNGEONS: Readonly<Record<string, readonly DungeonRoom[]>> = {
  [LOST_MINE]: [
    { name: 'Cave Entrance', text: 'Scry 1.', exits: ['Goblin Lair', 'Mine Tunnels'] },
    { name: 'Goblin Lair', text: 'Create a 1/1 red Goblin creature token.', exits: ['Storeroom', 'Dark Pool'] },
    { name: 'Mine Tunnels', text: 'Create a Treasure token.', exits: ['Dark Pool', 'Fungi Cavern'] },
    { name: 'Storeroom', text: 'Put a +1/+1 counter on target creature.', exits: ['Temple of Dumathoin'] },
    { name: 'Dark Pool', text: 'Each opponent loses 1 life and you gain 1 life.', exits: ['Temple of Dumathoin'] },
    { name: 'Fungi Cavern', text: 'Target creature gets -4/-0 until your next turn.', exits: ['Temple of Dumathoin'] },
    { name: 'Temple of Dumathoin', text: 'Draw a card.', exits: [] },
  ],
  [MAD_MAGE]: [
    { name: 'Yawning Portal', text: 'You gain 1 life.', exits: ['Dungeon Level'] },
    { name: 'Dungeon Level', text: 'Scry 1.', exits: ['Goblin Bazaar', 'Twisted Caverns'] },
    { name: 'Goblin Bazaar', text: 'Create a Treasure token.', exits: ['Lost Level'] },
    { name: 'Twisted Caverns', text: "Target creature can't attack until your next turn.", exits: ['Lost Level'] },
    { name: 'Lost Level', text: 'Scry 2.', exits: ['Runestone Caverns', "Muiral's Graveyard"] },
    { name: 'Runestone Caverns', text: 'Exile the top two cards of your library. You may play them.', exits: ['Deep Mines'] },
    { name: "Muiral's Graveyard", text: 'Create two 1/1 black Skeleton creature tokens.', exits: ['Deep Mines'] },
    { name: 'Deep Mines', text: 'Scry 3.', exits: ["Mad Wizard's Lair"] },
    { name: "Mad Wizard's Lair", text: 'Draw three cards and reveal them. You may cast one of them without paying its mana cost.', exits: [] },
  ],
  [TOMB]: [
    { name: 'Trapped Entry', text: 'Each player loses 1 life.', exits: ['Veils of Fear', 'Oubliette'] },
    { name: 'Veils of Fear', text: 'Each player loses 2 life unless they discard a card.', exits: ['Sandfall Cell'] },
    { name: 'Sandfall Cell', text: 'Each player loses 2 life unless they sacrifice an artifact, a creature, or a land.', exits: ['Cradle of the Death God'] },
    { name: 'Oubliette', text: 'Discard a card and sacrifice an artifact, a creature, and a land.', exits: ['Cradle of the Death God'] },
    { name: 'Cradle of the Death God', text: 'Create a 4/4 black God Horror creature token with deathtouch.', exits: [] },
  ],
  [UNDERCITY]: [
    { name: 'Secret Entrance', text: 'Search your library for a basic land card, reveal it, put it into your hand, then shuffle.', exits: ['Forge', 'Lost Well'] },
    { name: 'Forge', text: 'Put two +1/+1 counters on target creature.', exits: ['Trap!', 'Arena'] },
    { name: 'Lost Well', text: 'Scry 2.', exits: ['Arena', 'Stash'] },
    { name: 'Trap!', text: 'Target player loses 5 life.', exits: ['Archives', 'Catacombs'] },
    { name: 'Arena', text: 'Goad target creature.', exits: ['Archives', 'Catacombs'] },
    { name: 'Stash', text: 'Create a Treasure token.', exits: ['Archives', 'Catacombs'] },
    { name: 'Archives', text: 'Draw a card.', exits: ['Throne of the Dead Three'] },
    { name: 'Catacombs', text: 'Create a 4/1 black Skeleton creature token with menace.', exits: ['Throne of the Dead Three'] },
    {
      name: 'Throne of the Dead Three',
      text: 'Reveal the top ten cards of your library. Put a creature card from among them onto the battlefield with three +1/+1 counters on it. It gains hexproof until your next turn. Then shuffle.',
      exits: [],
    },
  ],
};

/** A dungeon card's printed text: its rooms, one to a line. */
const dungeonText = (name: string): string => (DUNGEONS[name] ?? [])
  .map((room) => `${room.name} — ${room.text}`).join('\n');

/**
 * The rooms a venture can move a seat's marker to (CR 309.5): the exits of the room it is on, or the
 * top room of `dungeon` when the seat is in no dungeon. Into Undercity while already in another
 * dungeon is a move in that one (CR 701.49c), so the dungeon in progress is the one read.
 */
export function nextRooms(state: GameState, seat: SeatIndex, dungeon: string): readonly string[] {
  const at = state.dungeon?.[String(seat)];
  if (at !== undefined && state.instances[at.emblem]?.zone === 'command') {
    return DUNGEONS[at.name]?.find((room) => room.name === at.room)?.exits ?? [];
  }
  const top = DUNGEONS[dungeon]?.[0];
  return top === undefined ? [] : [top.name];
}

/** Whether the seat's marker is in a dungeon now (D1163). */
export function inDungeon(state: GameState, seat: SeatIndex): boolean {
  const at = state.dungeon?.[String(seat)];
  return at !== undefined && state.instances[at.emblem]?.zone === 'command';
}

/**
 * Venture (D1160, CR 701.49): the marker moves to `choice` if it is one of `nextRooms`, otherwise to
 * the first of them, and that room's ability triggers (CR 309.4c). The trigger is the dungeon
 * card's reflexive one keyed by the room, so it goes on the stack and chooses its targets there.
 * A seat in no dungeon puts `dungeon` into its command zone first. A marker already on the bottom
 * room goes nowhere: that dungeon is completed as its last room resolves.
 */
export function ventureInto(state: GameState, seat: SeatIndex, dungeon: string, choice?: string | null): GameState {
  const rooms = nextRooms(state, seat, dungeon);
  if (rooms.length === 0) return state;
  const room = choice !== undefined && choice !== null && rooms.includes(choice) ? choice : rooms[0]!;
  let next = state;
  let at = next.dungeon?.[String(seat)];
  if (at === undefined || next.instances[at.emblem]?.zone !== 'command') {
    next = createEmblem(next, seat, dungeonText(dungeon), dungeon, dungeon);
    at = { name: dungeon, room, emblem: `e${seat}_${next.instanceSeq}` };
  }
  return {
    ...next,
    dungeon: { ...(next.dungeon ?? {}), [String(seat)]: { ...at, room } },
    reflexive: [...(next.reflexive ?? []), { source: at.emblem, key: room, controller: seat }],
  };
}

/** The dungeon is completed (CR 309.7): its card leaves the command zone and the count goes up. */
export function completeDungeon(state: GameState, seat: SeatIndex): GameState {
  const at = state.dungeon?.[String(seat)];
  if (at === undefined) return state;
  const command = zoneKey(seat, 'command');
  const { [String(seat)]: _gone, ...rest } = state.dungeon ?? {};
  return withZones({
    ...state,
    dungeon: rest,
    dungeonsCompleted: {
      ...(state.dungeonsCompleted ?? {}),
      [String(seat)]: [...(state.dungeonsCompleted?.[String(seat)] ?? []), at.name],
    },
  }, { [command]: listAt(state, command).filter((id) => id !== at.emblem) });
}

/**
 * Taking the initiative (D1160, CR 722.2): the seat has it, and The Initiative's card moves to that
 * seat's command zone, or is made there. The venture that comes with it is the caller's, so a
 * question about which room can be asked.
 */
export function takeInitiative(state: GameState, seat: SeatIndex): GameState {
  const card = Object.values(state.instances).find((inst) => inst.zone === 'command'
    && state.cardDefs[inst.defKey]?.name === THE_INITIATIVE);
  let next: GameState = { ...state, initiative: seat };
  if (card === undefined) return createEmblem(next, seat, INITIATIVE_TEXT, THE_INITIATIVE, THE_INITIATIVE);
  if (card.zoneSeat === seat) return next;
  const from = zoneKey(card.zoneSeat, 'command');
  const to = zoneKey(seat, 'command');
  next = withZones(next, { [from]: listAt(next, from).filter((id) => id !== card.id), [to]: [...listAt(next, to), card.id] });
  return { ...next, instances: { ...next.instances, [card.id]: { ...card, owner: seat, zoneSeat: seat } } };
}

/** The Initiative's card, wherever it is (D1160). */
export function initiativeCard(state: GameState): string | undefined {
  return Object.values(state.instances).find((inst) => inst.zone === 'command'
    && state.cardDefs[inst.defKey]?.name === THE_INITIATIVE)?.id;
}

/** Every emblem a seat has (D734), in the order they were made. */
export function emblemsOf(state: GameState, seat: SeatIndex): readonly string[] {
  return listAt(state, zoneKey(seat, 'command')).filter((id) => state.instances[id]?.emblem === true);
}

/**
 * Phasing out (D733, CR 702.26): each permanent is treated as though it does not exist until its
 * controller's next untap step. No zone changes, so nothing triggers, and counters, damage, tapped
 * state and attachments stay. What is attached to it phases out with it, indirectly (CR 702.26g).
 * Out of combat, as a permanent that ceased to exist would be.
 */
export function phaseOut(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  const direct = ids.filter((id) => next.instances[id]?.zone === 'battlefield');
  const out = new Map<string, boolean>();
  for (const id of direct) out.set(id, false);
  // Attached to something phasing out, and so on down: an Aura on an Aura goes too.
  for (let grew = true; grew;) {
    grew = false;
    for (const inst of Object.values(next.instances)) {
      if (inst.zone === 'battlefield' && inst.attachedTo !== null && out.has(inst.attachedTo) && !out.has(inst.id)) {
        out.set(inst.id, true);
        grew = true;
      }
    }
  }
  for (const [id, indirect] of out) {
    const inst = next.instances[id]!;
    const from = zoneKey(inst.zoneSeat, 'battlefield');
    const to = zoneKey(inst.zoneSeat, 'phased');
    next = withZones(next, {
      [from]: listAt(next, from).filter((other) => other !== id),
      [to]: [...listAt(next, to).filter((other) => other !== id), id],
    });
    next = withInstance(next, id, { zone: 'phased', ...(indirect ? { phasedIndirectly: true as const } : {}) });
    next = removeFromCombat(next, id);
    // For "whenever ~ phases out" (D1029), announced by `settle`.
    next = { ...next, phased: [...(next.phased ?? []), { id, dir: 'out' as const }] };
  }
  return next;
}

/**
 * Phasing in (D733, CR 502.1): everything that phased out under this seat comes back as its untap
 * step begins, before anything untaps, with whatever phased out indirectly with it. An indirectly
 * phased permanent never phases in by itself.
 */
export function phaseIn(state: GameState, seat: SeatIndex): GameState {
  const key = zoneKey(seat, 'phased');
  const phased = listAt(state, key);
  if (phased.length === 0) return state;
  let next = state;
  const coming = new Set(phased.filter((id) => next.instances[id]?.phasedIndirectly !== true));
  // And what rode out on them, wherever it is held: another seat's Aura on this seat's creature.
  for (let grew = true; grew;) {
    grew = false;
    for (const inst of Object.values(next.instances)) {
      if (inst.zone === 'phased' && inst.phasedIndirectly === true && inst.attachedTo !== null
        && coming.has(inst.attachedTo) && !coming.has(inst.id)) {
        coming.add(inst.id);
        grew = true;
      }
    }
  }
  for (const id of coming) {
    const inst = next.instances[id]!;
    const from = zoneKey(inst.zoneSeat, 'phased');
    const to = zoneKey(inst.zoneSeat, 'battlefield');
    next = withZones(next, {
      [from]: listAt(next, from).filter((other) => other !== id),
      [to]: [...listAt(next, to).filter((other) => other !== id), id],
    });
    next = withInstance(next, id, { zone: 'battlefield', phasedIndirectly: undefined });
    // For "whenever ~ phases in" (D1029), announced by `settle`.
    next = { ...next, phased: [...(next.phased ?? []), { id, dir: 'in' as const }] };
  }
  return next;
}

/**
 * "Your life total can't change" until your next turn (D733, Teferi's Protection): life is neither
 * gained nor lost, damage is still dealt, and no life can be paid (CR 119.7, 119.8).
 */
export function lockLife(state: GameState, seat: SeatIndex, source: string): GameState {
  return pushEffect(state, {
    source,
    controller: seat,
    scope: { kind: 'seat', seat },
    lifeLocked: true,
    duration: 'until-controllers-next-turn',
  });
}

/** "You gain protection from everything until your next turn" (D718). See `playerProtection`. */
export function protectPlayer(state: GameState, seat: SeatIndex, source: string): GameState {
  return pushEffect(state, {
    source,
    controller: seat,
    scope: { kind: 'seat', seat },
    playerProtection: true,
    duration: 'until-controllers-next-turn',
  });
}

export function goad(
  state: GameState, ids: readonly string[], source: string, controller: SeatIndex,
): GameState {
  return pump(state, ids, source, controller, {
    mustAttack: true,
    mustAttackAnotherPlayer: true,
    duration: 'until-controllers-next-turn',
  });
}

/**
 * "Prevent all combat damage that would be dealt this turn" — a Fog, and the one-creature version.
 *
 * `ids` names the creatures whose combat damage is prevented; leaving it out covers every creature
 * on the table, which is what a Fog does and is symmetrical on purpose: it stops the swing coming
 * back as well as the swing going out.
 */
/**
 * "Prevent all [combat] damage that would be dealt to / by …" this turn (D738). `scope` is the
 * permanents it is about; `players` the player half ("to you", "to players").
 */
export function preventDamageThisTurn(
  state: GameState, source: string, controller: SeatIndex,
  opts: {
    readonly direction: 'to' | 'by'; readonly combatOnly: boolean;
    readonly scope?: ContinuousEffect['scope']; readonly players?: 'controller' | 'all';
    /** "Until your next turn" (D1391), rather than this turn. */
    readonly untilYourNextTurn?: boolean;
  },
): GameState {
  return pushEffect(state, {
    source, controller,
    scope: opts.scope ?? { kind: 'cards', ids: [] },
    ...(opts.scope === undefined ? {} : opts.direction === 'to' ? { preventsDamageTo: true as const } : { preventsDamageFrom: true as const }),
    ...(opts.players === undefined ? {} : { preventsDamageToPlayers: opts.players }),
    ...(opts.combatOnly ? { preventsCombatOnly: true as const } : {}),
    duration: opts.untilYourNextTurn === true ? 'until-controllers-next-turn' : 'end-of-turn',
  });
}

export function preventCombatDamage(
  state: GameState, source: string, controller: SeatIndex, ids?: readonly string[],
): GameState {
  return pushEffect(state, {
    source,
    controller,
    scope: ids === undefined ? { kind: 'all-creatures' } : { kind: 'cards', ids: [...ids] },
    preventsCombatDamage: true,
    duration: 'end-of-turn',
  });
}

/** "Creatures you control get +3/+3 and gain trample until end of turn." */
/**
 * **A resolved spell's board-wide effect is locked to the board it saw, and a static ability's is
 * not** (CR 611.2c against CR 611.3, #280).

 * This was wrong, and it was wrong in the way a declarative scope invites: `{ kind:
 * 'controller-creatures' }` is re-read on every characteristics lookup, so an Overrun that resolved
 * with one 2/2 out was still pumping the Centaur Courser cast *afterwards* — the probe read it as
 * **6/6** off a printed 3/3. CR 611.2c says a continuous effect from a resolved spell or ability
 * applies only to the permanents that were there when the effect was created, and does not pick up
 * ones that arrive later. Only an effect from a **static** ability is dynamic, which is what
 * Glorious Anthem is and what it should be.
 *
 * **The negative sweeps are where it mattered, rather than the Overruns.** After a Toxic Deluge —
 * "all creatures get −X/−X" — a player is entitled to rebuild that turn. With a dynamic scope every
 * creature they played afterwards arrived already shrunk and died on the spot, which is a different
 * game rather than a different number.
 *
 * **`duration` is the discriminator, and it is the honest one here.** `'permanent'` is what
 * `staticEffect` uses and the only duration a static ability has; every other duration — end of
 * turn, end of combat, until your next turn — only exists because something *resolved* to create
 * it. So a permanent duration keeps the dynamic scope and anything else is resolved to an id list
 * now, through `pump`, which has carried `{ kind: 'cards' }` from the beginning. The two cases were
 * never distinguishable by looking at the scope, which is why reading the scope was the wrong place
 * to fix this.
 *
 * **One thing this does not fix, and inherits from `pump`:** a creature that dies and comes back is
 * a new object (CR 400.7) and should be out of the set, but `relocate` keeps its instance id, so an
 * id list still reaches it. That is pre-existing for every "target creature gets +3/+3" in the pool
 * and is not made worse here; it wants the object identity the engine does not yet have.
 */
export function pumpTeam(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  const duration = opts.duration ?? 'end-of-turn';
  if (duration !== 'permanent') {
    return pump(state, creaturesControlledBy(state, controller), source, controller, opts);
  }
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'controller-creatures' },
    ...modsFrom(opts),
    duration,
  });
}

/**
 * "All creatures get -1/-1 until end of turn", and anything else that hits the whole board.
 *
 * Symmetrical on purpose: the scope is every creature, including the caster's own, which is what
 * makes a card like this a decision rather than a removal spell.
 */
export function pumpAll(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  // Locked to the board it saw unless it came from a static ability — see `pumpTeam` above
  // (CR 611.2c, #280). This is the half that mattered: the −X/−X sweeps.
  const duration = opts.duration ?? 'end-of-turn';
  if (duration !== 'permanent') {
    const ids = state.seats.flatMap((seat) => creaturesControlledBy(state, seat.index));
    return pump(state, ids, source, controller, opts);
  }
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'all-creatures' },
    ...modsFrom(opts),
    duration,
  });
}

/** A permanent's own static effect, which lasts as long as it is on the battlefield. */
export function staticEffect(
  state: GameState, source: string, controller: SeatIndex,
  scope: ContinuousEffect['scope'], opts: PumpOptions,
): GameState {
  let next = pushEffect(state, { source, controller, scope, ...modsFrom(opts), duration: 'permanent' });
  for (const part of opts.alsoParts ?? []) next = staticEffect(next, source, controller, scope, part);
  return next;
}

/**
 * Removes the static effects a given permanent is the source of: an Aura's or Equipment's bonus,
 * when the attachment ends or moves.
 *
 * **Only the `permanent` ones** (D624). An Aura or Equipment can also be the source of an effect
 * its own activated ability made — "{R}: Equipped creature gains first strike until end of turn" —
 * and that effect, once the ability has resolved, lasts as long as it says whatever happens to its
 * source (CR 611.2a). Removed with the bonus, moving the Equipment to another creature took the
 * first strike off the first one mid-turn.
 */
export function removeEffectsFrom(state: GameState, source: string): GameState {
  const effects = state.effects.filter((e) => e.source !== source || e.duration !== 'permanent');
  return effects.length === state.effects.length ? state : { ...state, effects };
}

// ── Target helpers scripts use constantly ────────────────────────────────────────────────────────

export const firstCardTarget = (ctx: EffectContext): string | null => {
  const t = ctx.targets.find((x) => x.kind === 'card');
  return t && t.kind === 'card' ? t.id : null;
};

export const cardTargets = (ctx: EffectContext): string[] =>
  ctx.targets.filter((t): t is Extract<Target, { kind: 'card' }> => t.kind === 'card').map((t) => t.id);

export const firstPlayerTarget = (ctx: EffectContext): SeatIndex | null => {
  const t = ctx.targets.find((x) => x.kind === 'player');
  return t && t.kind === 'player' ? t.seat : null;
};

/**
 * The ability on the stack this spell was pointed at, by stack-object id.
 *
 * Its own helper rather than `firstCardTarget` because an ability is not a card: the id names an
 * entry in `stackObjects` and nothing in `instances`, so a script that confused the two would look
 * up a creature that does not exist and silently do nothing.
 */
export const firstAbilityTarget = (ctx: EffectContext): string | null => {
  const t = ctx.targets.find((x) => x.kind === 'ability');
  return t && t.kind === 'ability' ? t.id : null;
};

/**
 * The targets of a spell that divided a quantity among them, each with its share (CR 601.2d).
 *
 * Only the ones with a share in it: a target assigned nothing is not a target this spell has, so
 * a card reading this list never has to decide what zero means. A spell whose `division` is
 * missing yields nothing at all rather than guessing one each — the engine refuses to cast a
 * dividing spell without a division, so an empty list here means the card asked for a division it
 * does not declare, and doing nothing is the honest answer to that.
 */
export const dividedAmong = (
  ctx: EffectContext,
): readonly { readonly target: Target; readonly amount: number }[] =>
  ctx.targets.flatMap((target, i) => {
    const amount = ctx.division?.[i] ?? 0;
    return amount > 0 ? [{ target, amount }] : [];
  });

/** The cards chosen in answer to one of the questions this spell asked, by index. */
export const chosenCards = (ctx: EffectContext, index = 0): readonly string[] =>
  ctx.decisions[index]?.ids ?? [];

/** The one card chosen in answer to a question, or null — a search that found nothing is legal. */
export const chosenCard = (ctx: EffectContext, index = 0): string | null =>
  ctx.decisions[index]?.ids[0] ?? null;

/**
 * The word chosen in answer to a question — a creature type, a colour, "untap".
 *
 * `null` when the question was never asked, which happens for real: a choice between fewer than
 * two words is answered by the engine, and a seat eliminated mid-resolution answers nothing at
 * all. Every caller has to say what it does then, and for most of them the answer is "nothing".
 */
/**
 * The answer that means "a +1/+1 counter" to riot's and unleash's question (D559). One constant,
 * read by the reader that asks and the arrival that acts, so the two cannot drift apart.
 */
export const ENTERS_COUNTER_OPTION = '+1/+1 counter';

/**
 * "The chosen type" (D641), written where a creature type goes in a static — a scope's `subtype` or
 * an `addSubtypes` entry — and replaced, as the static is installed, by the type the permanent
 * chose as it entered. Two words with a space, so it can never be a real subtype.
 */
export const CHOSEN_TYPE = 'the chosen type';

/** "The chosen color" (D643), in a static scope's `color`: replaced on install, as `CHOSEN_TYPE` is. */
export const CHOSEN_COLOR = 'the chosen color';

/** "The chosen name" (D1237), in a static scope's `name`: replaced on install, as `CHOSEN_TYPE` is. */
export const CHOSEN_NAME = 'the chosen name';

export const chosenOption = (ctx: EffectContext, index = 0): string | null =>
  ctx.decisions[index]?.option ?? null;

/** Puts chosen cards into a hand, which is what a tutor does. */
export function moveToHand(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = relocate(next, inst, 'hand', inst.owner, 'bottom');
  }
  return next;
}

/** Puts chosen cards into their owner's graveyard: a discard, or a sacrifice. */
/**
 * Sacrifices permanents: each goes to its owner's graveyard, and the act is recorded (D570).
 *
 * **The one place a sacrifice is performed.** There used to be none — a sacrifice was a `relocate`
 * to a graveyard written out wherever one was needed, five times in the engine and behind
 * `moveToGraveyard` in every script — which was indistinguishable from a destruction afterwards and
 * is why "whenever you sacrifice a permanent" could not be an event. Now the cost of a spell, the
 * cost of an ability, a Treasure spent for mana, a finished Saga, echo declined and an edict all
 * come through here, and `AutomationState.sacrificed` says who did it.
 *
 * Not a destruction (CR 701.17a): indestructible does not stop it and nothing regenerates from it,
 * which is why this is a move and not a call to `destroy`. A card that is not on the battlefield is
 * not sacrificed — it is left exactly where it is — because a sacrifice is a thing done to a
 * permanent you control, and an effect that has lost its permanent has nothing to give up.
 */
export function sacrifice(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined || inst.zone !== 'battlefield') continue;
    if (next.automated) {
      next = { ...next, sacrificed: [...(next.sacrificed ?? []), { card: id, seat: inst.zoneSeat }] };
    }
    next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/**
 * Puts cards into their owners' graveyards, from wherever they are.
 *
 * For a card in a hand that is a discard and for one in a library a mill, and `relocate` tells
 * those apart by the zone it left. For a **permanent** it is a sacrifice, and has been at every
 * call site since the function was written — an edict's chosen creature, echo declined, vanishing
 * run out — because the two other ways a permanent reaches a graveyard have functions of their own:
 * `destroy`, and the state-based actions. So a permanent is handed to `sacrifice`, which is what
 * records the act (D570). One rule here instead of twenty-two call sites each remembering.
 */
export function moveToGraveyard(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = inst.zone === 'battlefield'
      ? sacrifice(next, [id])
      : relocate(next, inst, 'graveyard', inst.owner, 'bottom');
  }
  return next;
}

/** The instance a spell or ability came from, if it still exists. */
export const sourceOf = (ctx: EffectContext) => ctx.state.instances[ctx.source];

export { requireInstance, listAt, withInstance, relocate };

// ── Casting a card the long way round ────────────────────────────────────────────────────────────

/**
 * Puts a pile of cards on the bottom of their owners' libraries in a random order (CR 701.19).
 *
 * The end of a cascade, and the one line of it that is not about casting anything. Random rather
 * than in the order they were exiled, because the order they were exiled in is the order they were
 * *in*: a cascade that put them back in sequence would hand the player the top of their library
 * for the rest of the game, which is the opposite of what the keyword costs them.
 *
 * Shuffled against the game's own generator rather than `Math.random`, so a table replayed from
 * its action log puts the same cards back in the same places — the rule every shuffle in this
 * engine follows.
 */
export function bottomPile(state: GameState, ids: readonly string[]): GameState {
  if (ids.length === 0) return state;
  const rng = mulberry32(actionSeed(state.rngSeed, state.stateVersion + state.autoSeq));
  let next = state;
  for (const id of shuffled(ids, rng)) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = relocate(next, inst, 'library', inst.owner, 'bottom');
  }
  return next;
}

/**
 * Madness (CR 702.35a): a discarded card goes to exile instead, to be cast for a different cost.
 *
 * The same offer cascade makes, with a price on it — which is why it is the same field. The card is
 * in the graveyard when this runs (the engine replaces a zone change by letting it happen and then
 * moving the card on, see `settle`), so this is two moves and a sentence: out of the graveyard into
 * exile, and `pendingOfferedCast` naming the seat, the card and what casting it costs.
 *
 * `toGraveyard` on the offer is the half that makes declining mean what it says. A cascade hit
 * nobody wants is already where it belongs; a madness card nobody wants has to finish the move it
 * interrupted and go to the graveyard it was being discarded to.
 *
 * Whose offer it is: the card's **owner**, not the controller of whatever made them discard. Mind
 * Rot makes you discard and the madness is yours.
 */
export function madnessOffer(state: GameState, card: string, cost: string): GameState {
  const inst = state.instances[card];
  if (inst === undefined) return state;
  const name = state.cardDefs[inst.defKey]?.name ?? 'it';
  const next = relocate(state, inst, 'exile', inst.owner, 'bottom');
  return {
    ...next,
    pendingOfferedCast: {
      seat: inst.owner,
      card,
      cost,
      prompt: `${name} was discarded: you may cast it for ${cost} (madness)`,
      toGraveyard: true,
      source: card,
    },
  };
}

/**
 * Cascade (CR 702.85a): exile cards off the top until a cheaper one turns up, and offer it free.
 *
 * Two halves, and the second one is why this function stops rather than finishing the job. Exiling
 * is something the engine can simply do; **casting is a choice**, and it is a choice with every
 * other choice inside it — which half of a split card, which creature the spell is pointed at, how
 * the three damage is divided. None of that can be answered here, mid-resolution, and an engine
 * that answered it for the player would be playing their turn for them.
 *
 * So it ends by setting `pendingOfferedCast` and getting out of the way: the table stops, the player
 * casts through the ordinary cast path with the ordinary questions, and the leftovers go to the
 * bottom whichever way they answer. See `GameState.pendingOfferedCast`.
 *
 * The mana value compared against is the **printed** value of the card the keyword is on, read
 * from its definition rather than from the spell on the stack. That is deliberate: a cascading
 * spell that has already been countered still cascades (the trigger resolves on its own), and by
 * then the stack object it came from is gone — reading the value from there would compare against
 * nought and exile the whole library.
 *
 * A land is never the hit, however cheap it is, and neither is a card whose value is equal rather
 * than less: "lesser mana value" and "nonland card" are both load-bearing, and both are the reason
 * cascade is not simply a free spell. Running out of library is a legal outcome — the whole pile
 * goes back to the bottom and the cascade did nothing.
 */
export function cascadeFrom(ctx: EffectContext, discover?: number): GameState {
  const { controller } = ctx;
  const inst = ctx.state.instances[ctx.source];
  if (inst === undefined) return ctx.state;
  const def = ctx.state.cardDefs[inst.defKey];
  /*
    Discover N (D1043, CR 701.57a) is the same walk with two differences: the limit is N and a card
    of **exactly** N is a hit ("N or less" where cascade says "less than"), and a hit not cast goes
    to its owner's hand rather than to the bottom. `limit` is then N + 1, so one comparison serves.
  */
  const limit = discover === undefined ? costValue(parseManaCost(def?.manaCost)) : discover + 1;
  const name = def?.name ?? 'it';
  let next = ctx.state;
  const exiled: string[] = [];
  let hit: string | undefined;
  /*
    One card at a time off the top, with the library re-read each pass.

    A bound of the library's size rather than `while (true)`: a card that somehow failed to move
    would otherwise spin here, and this runs inside `settle`, which has nowhere to report a hang to.
  */
  const size = listAt(next, zoneKey(controller, 'library')).length;
  for (let i = 0; i < size; i += 1) {
    const top = listAt(next, zoneKey(controller, 'library'))[0];
    if (top === undefined) break;
    const card = next.instances[top];
    if (card === undefined) break;
    next = relocate(next, card, 'exile', card.owner, 'bottom');
    exiled.push(top);
    const topDef = next.cardDefs[card.defKey];
    const isLand = hasType(parseTypeLine(topDef?.typeLine), 'land');
    if (!isLand && costValue(parseManaCost(topDef?.manaCost)) < limit) {
      hit = top;
      break;
    }
  }
  if (hit === undefined) return bottomPile(next, exiled);
  const rest = exiled.filter((id) => id !== hit);
  const hitName = next.cardDefs[next.instances[hit]?.defKey ?? '']?.name ?? 'it';
  return {
    ...next,
    pendingOfferedCast: {
      seat: controller,
      card: hit,
      prompt: discover === undefined
        ? `${name} cascades into ${hitName}: you may cast it without paying its mana cost`
        : `${name} discovers ${hitName}: you may cast it without paying its mana cost, or put it into your hand`,
      bottom: rest,
      source: ctx.source,
      ...(discover === undefined ? {} : { toHand: true as const }),
    },
  };
}
