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
import {
  characteristicsOf, hasType, parseTypeLine, protectedFrom, type ContinuousEffect,
  type EffectDuration, type Keyword,
} from './characteristics.js';
import { defKeyFor, zoneKey, type CardDef, type CardInstance } from './cards.js';
import {
  drawFromLibrary, listAt, normaliseDef, relocate, requireInstance, withInstance, withZones,
} from './cardActions.js';
import { actionSeed, clampValue, mulberry32, replaceSeat, shuffled } from './internal.js';
import { targetSeqsFor } from './targeting.js';
import type { Color, ManaType } from './mana.js';
import { addMana, costValue, EMPTY_POOL, parseManaCost, xMultiplier } from './mana.js';
import type { AttackedTarget, DecisionAnswer, StackObject, Step, Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/** What an effect is given when it runs. */
export interface EffectContext {
  readonly state: GameState;
  /** The permanent or spell the effect comes from. */
  readonly source: string;
  readonly controller: SeatIndex;
  readonly targets: readonly Target[];
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
   * What the attack that caused this trigger was aimed at, for an attack trigger that has to say
   * "the player or planeswalker it's attacking". Undefined for everything else.
   */
  readonly attacked?: AttackedTarget;
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
   * The counters the permanent this trigger is about had before the event, by counter name.
   *
   * Undefined for everything that is not a death trigger, and for a permanent that had none. It
   * exists because a card in a graveyard has no counters — `relocate` takes them off, which is the
   * rule — so "for each +1/+1 counter on it" has to be answered from what was true when it died
   * (CR 608.2h). See `StackObject.subjectCounters`.
   */
  readonly subjectCounters?: Readonly<Record<string, number>>;
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
  state: GameState, target: Target, amount: number,
): { readonly state: GameState; readonly amount: number } {
  let left = amount;
  let changed = false;
  const kept: ContinuousEffect[] = [];
  for (const effect of state.effects) {
    const shield = effect.preventsDamageAmount;
    if (shield === undefined || shield <= 0 || left <= 0 || !shieldCovers(effect, target)) {
      kept.push(effect);
      continue;
    }
    const used = Math.min(shield, left);
    left -= used;
    changed = true;
    if (shield - used > 0) kept.push({ ...effect, preventsDamageAmount: shield - used });
  }
  return { state: changed ? { ...state, effects: kept } : state, amount: left };
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
    if (shieldCovers(effect, target)) total += shield;
  }
  return total;
}

/** Whether a shield is on this target: a permanent by id, or a player by seat. */
function shieldCovers(effect: ContinuousEffect, target: Target): boolean {
  // An ability cannot be damaged, so it cannot be shielded either. Said here as well as in
  // `dealDamage` because this is reached from `spendShields`, and a shield that matched an ability
  // id would be spent on damage that was never going to happen.
  if (target.kind === 'ability') return false;
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
export function preventDamage(
  state: GameState, source: string, controller: SeatIndex, target: Target, amount: number,
): GameState {
  if (amount <= 0) return state;
  // Nothing can be prevented on an ability: see `dealDamage`.
  if (target.kind === 'ability') return state;
  return pushEffect(state, {
    source,
    controller,
    scope: target.kind === 'player'
      ? { kind: 'seat', seat: target.seat }
      : { kind: 'cards', ids: [target.id] },
    preventsDamageAmount: amount,
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
    readonly deathtouch?: boolean;
    readonly lifelink?: boolean;
    readonly controller?: SeatIndex;
    /**
     * The attacking creature, when this is **combat** damage. Only combat damage from a commander
     * counts towards the twenty-one that eliminates a player (CR 903.10), so this is passed by
     * `dealCombatDamage` and by nothing else — a burn spell cast by a commander is not it, and a
     * single `source` option would have been quietly wrong for exactly that case.
     */
    readonly combatFrom?: string;
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
  // Protection from the source's colour prevents the damage entirely (CR 702.16b). Asked before
  // anything is marked, because prevention is not something that can be undone afterwards.
  if (target.kind === 'card' && protectedFrom(next, target.id, opts.source)) return next;
  /*
    Then prevention shields take what they can (CR 615.1), also before anything is marked.

    `left` rather than `amount` from here down, and every use of it matters: damage that was
    prevented is damage that was never dealt, so it does not reduce life, does not mark a creature,
    does not count towards the twenty-one a commander needs, does not mark deathtouch, and gains no
    life for a lifelink source. A shield read after the fact could not do any of that.
  */
  const shielded = spendShields(next, target, amount);
  next = shielded.state;
  const left = shielded.amount;
  if (left <= 0) return next;
  /*
    Infect, which changes what the damage *becomes* rather than whether it is dealt (CR 702.90b).

    A fact about the **source**, like protection and like deathtouch, so it is read off whatever
    dealt the damage — a creature on the battlefield, or a spell whose own id is its card. Read
    after the shields have taken their share, because prevented damage is damage that was never
    dealt and poison is no different from life in that regard.
  */
  const infect = opts.source !== null
    && next.instances[opts.source] !== undefined
    && characteristicsOf(next, next.instances[opts.source]!).keywords.has('infect');
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
      : { commanderDamage: { ...seat.commanderDamage, [key]: (seat.commanderDamage[key] ?? 0) + left } };
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
      : recordLifeLost(
        replaceSeat(next, target.seat, { life: clampValue(seat.life - left), ...tally, ...dealt }),
        target.seat, left,
      );
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
      if (opts.lifelink && opts.controller !== undefined) next = gainLife(next, opts.controller, left);
      return next;
    }
    /*
      And to a creature, infect is `-1/-1` counters instead of marked damage (CR 702.90b).

      The difference is permanent: marked damage is wiped in the cleanup step and a counter is not,
      so a 3/3 that took two infect damage is a 1/1 for the rest of the game. Deathtouch still
      applies on top, because damage *was* dealt and that is all deathtouch asks (CR 702.2b).
    */
    next = infect
      ? withInstance(next, inst.id, {
        counters: {
          ...inst.counters,
          '-1/-1': clampValue((inst.counters['-1/-1'] ?? 0) + left),
          ...(opts.deathtouch ? { deathtouched: 1 } : {}),
        },
      })
      : withInstance(next, inst.id, {
        damage: clampValue(inst.damage + left),
        // Any damage from a deathtouch source destroys the creature (CR 702.2b). Marking it keeps
        // state-based actions the only place something actually dies.
        ...(opts.deathtouch ? { counters: { ...inst.counters, deathtouched: 1 } } : {}),
      });
  }
  if (opts.lifelink && opts.controller !== undefined) next = gainLife(next, opts.controller, left);
  return next;
}

export function gainLife(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  return replaceSeat(state, seat, { life: clampValue(s.life + amount) });
}

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

/** "Pay {E}{E}" — the same arithmetic the other way, named for what a card says. */
export function spendEnergy(state: GameState, seat: SeatIndex, amount: number): GameState {
  return addEnergy(state, seat, -amount);
}

export function loseLife(state: GameState, seat: SeatIndex, amount: number): GameState {
  if (amount <= 0) return state;
  const s = state.seats[seat];
  if (s === undefined) return state;
  return recordLifeLost(replaceSeat(state, seat, { life: clampValue(s.life - amount) }), seat, amount);
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
 * The marker a **renowned** creature carries (CR 702.112a).
 *
 * "If it isn't renowned" is an intervening-if about a state the creature holds, and the engine's
 * answer to any such state is a counter: already per-permanent, already serialised to Redis,
 * already visible on the card. A creature that leaves and comes back is a new object with no
 * counters, so renown is available again — which is exactly what the rules say.
 */
export const RENOWNED = 'renowned';

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

export function destroy(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  if (characteristicsOf(state, inst).keywords.has('indestructible')) return state;
  // Regeneration replaces the destruction rather than following it, so it is checked here — the
  // one place a card is destroyed on purpose — and again where lethal damage is noticed.
  const saved = spendRegeneration(state, id);
  if (saved !== null) return saved;
  return relocate(state, inst, 'graveyard', inst.owner, 'bottom');
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
  return relocate(state, inst, object.flashback === true ? 'exile' : 'graveyard', inst.owner, 'bottom');
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
export function returnExiledBy(state: GameState, exiledBy: string): GameState {
  let next = state;
  for (const [id, inst] of Object.entries(state.instances)) {
    if (inst.exiledBy !== exiledBy) continue;
    if (inst.zone !== 'exile') continue;
    next = withInstance(next, id, { exiledBy: undefined });
    const current = next.instances[id];
    if (current === undefined) continue;
    next = relocate(next, current, 'battlefield', current.owner, 'bottom');
  }
  return next;
}

export function bounceToHand(state: GameState, id: string): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return relocate(state, inst, 'hand', inst.owner, 'bottom');
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
export function counterSpell(state: GameState, id: string): GameState {
  const object = state.stackObjects[id];
  if (object === undefined) return state;
  const objects = { ...state.stackObjects };
  delete objects[id];
  const next: GameState = {
    ...state,
    stackObjects: objects,
    stackOrder: state.stackOrder.filter((o) => o !== id),
  };
  const inst = next.instances[id];
  if (object.kind !== 'spell' || inst === undefined) return next;
  // Exiled rather than buried when it was cast with flashback, countered or not (CR 702.33a).
  return spellLeavesStack(next, object, inst);
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
  return {
    ...state,
    autoSeq: seq,
    stackObjects: { ...state.stackObjects, [copyId]: copy },
    stackOrder: [...state.stackOrder, copyId],
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
export function wardAsks(ctx: EffectContext, cost: string, name: string): GameState {
  const { state } = ctx;
  const id = ctx.answering;
  if (id === undefined) return state;
  const object = state.stackObjects[id];
  if (object === undefined) return state;
  const payer = object.controller;
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
      prompt: `Pay ${cost} or ${object.description} is countered by ${name}'s ward`,
      counters: id,
      source: ctx.source,
    },
  };
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

export function draw(state: GameState, seat: SeatIndex, count: number): GameState {
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

export function tap(state: GameState, id: string, tapped = true): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  return withInstance(state, id, { tapped });
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
  },
): GameState {
  const seq = state.autoSeq + 1;
  return {
    ...state,
    autoSeq: seq,
    delayed: [...state.delayed, {
      id: `dl${seq}`,
      ...spec,
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

export function untapAll(state: GameState, seat: SeatIndex): GameState {
  let next = state;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
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
    if (inst.tapped) next = withInstance(next, id, { tapped: false });
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

export function addCounters(state: GameState, id: string, key: string, amount: number): GameState {
  const inst = state.instances[id];
  if (inst === undefined) return state;
  const value = clampValue((inst.counters[key] ?? 0) + amount);
  const counters = { ...inst.counters };
  if (value === 0) delete counters[key];
  else counters[key] = value;
  return withInstance(state, id, { counters });
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
export function becomeCopyOf(state: GameState, id: string, copying: string): GameState {
  const self = state.instances[id];
  const other = state.instances[copying];
  if (self === undefined || other === undefined) return state;
  if (state.cardDefs[other.defKey] === undefined) return state;
  return withInstance(state, id, {
    defKey: other.defKey,
    printedDefKey: self.printedDefKey ?? self.defKey,
  });
}

/**
 * `keyOverride` decides where the definition is registered, for a copy whose characteristics are
 * not the copied card's — see `TokenCopyProfile`. Every other caller hands over a definition whose
 * name is its own, and for those the key is that name.
 */
export function createToken(
  state: GameState, seat: SeatIndex, card: CardDef, count = 1, keyOverride?: string,
): GameState {
  const def = normaliseDef(card);
  const key = keyOverride ?? defKeyFor(def);
  const cardDefs = { ...state.cardDefs, [key]: state.cardDefs[key] ?? def };
  const instances = { ...state.instances };
  let seq = state.instanceSeq;
  const created: string[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
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
  return withZones({ ...state, cardDefs, instances, instanceSeq: seq, entered }, {
    [bf]: [...listAt(state, bf), ...created],
  });
}

/** Moves a permanent to another player's battlefield, which is what gaining control is. */
export function gainControl(state: GameState, id: string, seat: SeatIndex): GameState {
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'battlefield') return state;
  return relocate(state, inst, 'battlefield', seat, 'bottom');
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
  /** See `ContinuousEffect.preventsCombatDamage`. A Fog Bank is this, printed on a 0/2. */
  readonly preventsCombatDamage?: boolean;
  /** See `ContinuousEffect.mustAttack` — "attacks each combat if able" (CR 508.1d). */
  readonly mustAttack?: boolean;
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
  /** See `ContinuousEffect.setPower` — layer 7b, "becomes 1/1" rather than "gets +1/+1". */
  readonly setPower?: number;
  readonly setToughness?: number;
  /** See `ContinuousEffect.losesAllAbilities` — layer 6. */
  readonly losesAllAbilities?: boolean;
  /** See `ContinuousEffect.addTypes` — layer 4, "becomes a creature". */
  readonly addTypes?: readonly string[];
  readonly addSubtypes?: readonly string[];
  /** See `ContinuousEffect.setColors` — layer 5, "becomes red". */
  readonly setColors?: readonly Color[];
  /** See `ContinuousEffect.definesSize` — layer 7a, a size that is a count of the board. */
  readonly definesSize?: ContinuousEffect['definesSize'];
  /** See `ContinuousEffect.while` — metalcraft, and any other "as long as" clause. */
  readonly while?: ContinuousEffect['while'];
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
    ...(opts.preventsCombatDamage ? { preventsCombatDamage: true } : {}),
    ...(opts.mustAttack ? { mustAttack: true } : {}),
    ...(opts.cantBeBlockedByWalls ? { cantBeBlockedByWalls: true } : {}),
    ...(opts.cantBeBlocked ? { cantBeBlocked: true } : {}),
    ...(opts.landwalk === undefined ? {} : { landwalk: [...opts.landwalk] }),
    ...(opts.mustAttackAnotherPlayer ? { mustAttackAnotherPlayer: true } : {}),
    ...(opts.protectionFrom ? { protectionFrom: opts.protectionFrom } : {}),
    ...(opts.setPower === undefined ? {} : { setPower: opts.setPower }),
    ...(opts.setToughness === undefined ? {} : { setToughness: opts.setToughness }),
    ...(opts.losesAllAbilities ? { losesAllAbilities: true } : {}),
    ...(opts.addTypes ? { addTypes: opts.addTypes } : {}),
    ...(opts.addSubtypes ? { addSubtypes: opts.addSubtypes } : {}),
    ...(opts.setColors ? { setColors: opts.setColors } : {}),
    ...(opts.definesSize ? { definesSize: opts.definesSize } : {}),
    ...(opts.while ? { while: opts.while } : {}),
  };
}

function pushEffect(state: GameState, effect: Omit<ContinuousEffect, 'id' | 'createdTurn'>): GameState {
  const seq = state.autoSeq + 1;
  const full: ContinuousEffect = { ...effect, id: `fx${seq}`, createdTurn: state.turn };
  return { ...state, autoSeq: seq, effects: [...state.effects, full] };
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
export function pumpTeam(
  state: GameState, source: string, controller: SeatIndex, opts: PumpOptions,
): GameState {
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'controller-creatures' },
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
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
  return pushEffect(state, {
    source, controller,
    scope: { kind: 'all-creatures' },
    ...modsFrom(opts),
    duration: opts.duration ?? 'end-of-turn',
  });
}

/** A permanent's own static effect, which lasts as long as it is on the battlefield. */
export function staticEffect(
  state: GameState, source: string, controller: SeatIndex,
  scope: ContinuousEffect['scope'], opts: PumpOptions,
): GameState {
  return pushEffect(state, { source, controller, scope, ...modsFrom(opts), duration: 'permanent' });
}

/** Removes every effect a given permanent is the source of. Used when an aura leaves. */
export function removeEffectsFrom(state: GameState, source: string): GameState {
  const effects = state.effects.filter((e) => e.source !== source);
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
export function moveToGraveyard(state: GameState, ids: readonly string[]): GameState {
  let next = state;
  for (const id of ids) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
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
export function cascadeFrom(ctx: EffectContext): GameState {
  const { controller } = ctx;
  const inst = ctx.state.instances[ctx.source];
  if (inst === undefined) return ctx.state;
  const def = ctx.state.cardDefs[inst.defKey];
  const limit = costValue(parseManaCost(def?.manaCost));
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
      prompt: `${name} cascades into ${hitName}: you may cast it without paying its mana cost`,
      bottom: rest,
      source: ctx.source,
    },
  };
}
