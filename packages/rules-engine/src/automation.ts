/**
 * The automated engine: priority, the stack, the turn, and the rules that run themselves.
 *
 * This is the layer that turns the tabletop into something Arena-shaped. The tabletop beneath it is
 * untouched and still reachable — a card nobody has scripted can always be moved by hand — but with
 * `automated` set, the engine owns the turn: it unttaps, draws, passes priority, resolves the stack,
 * runs combat, checks state-based actions, and refuses plays that are not legal.
 *
 * ## Three things worth knowing before reading on
 *
 * **Nothing dies here.** Damage is marked; lethal damage is noticed by `stateBasedActions`, which
 * runs after every action. That is the rule (CR 704) and it is also what makes "pump it in response
 * to the bolt" work without a special case anywhere.
 *
 * **Triggers are raised by the engine, not by scripts.** A script declares *when* it wants to fire;
 * the moments themselves — a permanent entering, a creature dying, a spell being cast, life being
 * gained — are detected here, in `settle`, by comparing the state before and after. A script
 * cannot forget to announce itself because it never announces itself.
 *
 * **Every action ends in `settle`.** It loops state-based actions and trigger-stacking until the
 * game stops changing, which is the only way a chain (a creature dies, which triggers something,
 * which kills something else) comes out right.
 */
import {
  characteristicsOf, expireEffects, hasSubtype, hasType, type ContinuousEffect,
} from './characteristics.js';
import { zoneKey, type CardDef } from './cards.js';
import { listAt, relocate, requireInstance, withInstance, withZones } from './cardActions.js';
import {
  attackAimIssue, canAttack, canBlock, damageOrderChoice, damageOrdersOwed, dealCombatDamage,
  forcedAttackers, legalAttackers, legalBlockers, legalDefenders, menaceSatisfied,
  needsFirstStrikeStep, tapAttackers,
} from './combat.js';
import {
  REGENERATION, addCounters, destroy, draw, loseLife, modsFrom, poolOf, removeEffectsFrom,
  setPool, spendRegeneration, untapAll, type EffectContext, type EffectFn,
} from './effects.js';
import { manaSources } from './legalActions.js';
import { EngineError, type GameState, type Outcome, type SeatIndex } from './types.js';
import {
  EMPTY_POOL, addMana, canPay, parseManaCost, payCost, solveTap,
  type ManaPick, type ManaPool, type ManaType,
} from './mana.js';
import { actionSeed, mulberry32, replaceSeat, seatName, shuffled } from './internal.js';
import { scriptFor } from './scripts.js';
import type {
  AbilityCost, AbilityDef, CardScript, DecisionSpec, ModeDef, TargetSpec, TriggerEvent,
} from './scriptTypes.js';
import { targetCount } from './scriptTypes.js';
import {
  checkTargets, hasAnyLegalTargets, legalTargets, liveTargets, stillHasLegalTarget, targetSeqsFor,
} from './targeting.js';
import {
  EMPTY_COMBAT, MAIN_STEPS, NO_PRIORITY_STEPS, STEPS, STEP_LABELS, targetKey,
  type AttackedTarget, type DecisionAnswer, type StackObject, type Step, type Target,
} from './turnTypes.js';

export const MAX_HAND_SIZE = 7;

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────

// The action shapes live in `turnTypes.ts` so `types.ts` can put them in the Action union
// without importing this module, which imports `types.ts` itself.
export type {
  AutoAction, AutoStartAction, AutoPlayLandAction, AutoCastAction, AutoActivateAction,
  AutoPassAction, AutoAttackAction, AutoBlockAction, AutoOrderAction, AutoDiscardAction,
} from './turnTypes.js';
export { AUTO_ACTION_TYPES, isAutoAction } from './turnTypes.js';

// ── Small readers ────────────────────────────────────────────────────────────────────────────────

const aliveSeats = (state: GameState): SeatIndex[] =>
  state.seats.filter((s) => !s.eliminated).map((s) => s.index);

function nextAlive(state: GameState, from: SeatIndex): SeatIndex {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    if (state.seats[idx]?.eliminated === false) return idx;
  }
  return from;
}

/** The seat whose turn comes before `from`. `startAutomation` needs it to begin on the right seat. */
function prevAlive(state: GameState, from: SeatIndex): SeatIndex {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = ((from - step) % n + n) % n;
    if (state.seats[idx]?.eliminated === false) return idx;
  }
  return from;
}

/** How many cards a seat still owes the bottom of its library after mulliganing (CR 103.4c). */
export function bottomOwed(state: GameState, seat: SeatIndex): number {
  const mulligans = state.seats[seat]?.mulligans ?? 0;
  if (mulligans === 0) return 0;
  return Math.min(mulligans, listAt(state, zoneKey(seat, 'hand')).length);
}

/**
 * Creatures a seat may sacrifice to pay for one of `source`'s abilities.
 *
 * Empty when the cost asks for no sacrifice, which is also how `legalActions` tells an ability
 * that needs one from an ability that does not.
 */
export function sacrificeOptions(
  state: GameState, seat: SeatIndex, source: string, cost: AbilityCost,
): string[] {
  if (cost.sacrifice === undefined) return [];
  return listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
    if (cost.sacrifice === 'another-creature' && id === source) return false;
    const inst = state.instances[id];
    return inst !== undefined && characteristicsOf(state, inst).isCreature;
  });
}

/** Seats that have not yet settled on an opening hand. */
export function stillDeciding(state: GameState): SeatIndex[] {
  return state.seats.filter((s) => !s.eliminated && !state.kept.includes(s.index)).map((s) => s.index);
}

/**
 * The combat declaration the game is waiting for, if any.
 *
 * Declaring attackers and blockers are turn-based actions that happen as the step begins, before
 * anybody receives priority (CR 508.1, 509.1). So while one is outstanding nobody holds priority —
 * which is also what stops the attacking player from passing the blockers step away before the
 * defender has blocked, the bug this function exists to prevent.
 */
export function pendingDeclaration(
  state: GameState,
): { readonly kind: 'attackers' | 'blockers' | 'order'; readonly seats: readonly SeatIndex[] } | null {
  if (!state.automated) return null;
  if (state.step === 'declare-attackers' && !state.combat.attackersDeclared) {
    return { kind: 'attackers', seats: [state.activeSeat] };
  }
  if (state.step === 'declare-blockers') {
    const defenders = [...new Set(state.combat.attacks.map((a) => a.defender))].filter(
      (seat) => !state.combat.blockersDeclaredBy.includes(seat) && state.seats[seat]?.eliminated === false,
    );
    if (defenders.length > 0) return { kind: 'blockers', seats: defenders };
    /*
      And then the attacking player's damage assignment order (CR 509.2), which is the third
      turn-based action in combat and belongs here for the same reason as the other two: nobody
      holds priority while it is outstanding, so a UI keyed on priority alone would show an empty
      table waiting on nothing.

      After every defender has declared, never before: in a pod the order can only be settled once
      all the blocks are in, and the question is about the whole swing rather than one attack.
    */
    if (!state.combat.damageOrdered && damageOrdersOwed(state, state.activeSeat).length > 0) {
      return { kind: 'order', seats: [state.activeSeat] };
    }
  }
  return null;
}

export const stackTop = (state: GameState): StackObject | undefined => {
  const id = state.stackOrder[state.stackOrder.length - 1];
  return id === undefined ? undefined : state.stackObjects[id];
};

const scriptOf = (state: GameState, instanceId: string): CardScript | undefined => {
  const inst = state.instances[instanceId];
  return inst === undefined ? undefined : scriptFor(state.cardDefs[inst.defKey]?.name);
};

/** Sorcery timing: your own main phase, empty stack, and you hold priority. */
export function atSorcerySpeed(state: GameState, seat: SeatIndex): boolean {
  return (
    state.activeSeat === seat &&
    state.priority === seat &&
    state.stackOrder.length === 0 &&
    (MAIN_STEPS as readonly string[]).includes(state.step)
  );
}

// ── Priority and steps ───────────────────────────────────────────────────────────────────────────

/** After anything happens, the active player gets priority and everybody's passes are forgotten. */
/**
 * Hands priority back, unless something is blocking the game.
 *
 * The guard is here rather than at each call site because most actions end in
 * `resetPriority(settle(...))` and `settle` is where a trigger that needs aiming gets raised — so
 * an action that stopped the game to ask a question would otherwise hand priority straight back
 * over the top of it. Nobody holds priority while a question, a discard or a declaration is
 * outstanding, and a state that says otherwise makes a table offer a move the engine then refuses
 * for as long as the question stands.
 */
function resetPriority(state: GameState, to: SeatIndex = state.activeSeat): GameState {
  const blocked = state.openingHands || state.pendingDecision !== null || state.pendingChoice !== null
    || state.pendingDiscard !== null || pendingDeclaration(state) !== null;
  if (blocked) return { ...state, priority: null, passed: [] };
  return { ...state, priority: to, passed: [] };
}

/** Mana pools empty whenever a step or phase ends (CR 500.4). */
const emptyPools = (state: GameState): GameState => ({ ...state, pools: {} });

/**
 * Moves to the next step, doing whatever that step does on the way in.
 *
 * Loops rather than recurses, because several steps in a row can be empty — nobody has anything to
 * do in the beginning-of-combat step of a turn with no creatures — and each one has to be entered
 * and left properly rather than skipped over.
 */
function advanceStep(state: GameState): GameState {
  let next = emptyPools(state);
  for (let guard = 0; guard < 64; guard++) {
    const index = STEPS.indexOf(next.step);
    const isLast = index === STEPS.length - 1;
    let step: Step = isLast ? 'untap' : (STEPS[index + 1] as Step);

    if (isLast) {
      // Cleanup has finished: the turn ends and the next player's begins.
      next = {
        ...next,
        turn: next.turn + 1,
        activeSeat: nextAlive(next, next.activeSeat),
        combat: EMPTY_COMBAT,
      };
    }

    // Steps that exist only to hold a decision nobody can make are skipped rather than walked
    // through, so a turn with no creatures is not four extra rounds of passing.
    if (step === 'declare-attackers' && legalAttackers(next, next.activeSeat).length === 0) {
      step = 'end-combat';
    }
    // CR 508.1h: with no attackers declared, combat goes straight to its end.
    if (step === 'declare-blockers' && next.combat.attacks.length === 0) step = 'end-combat';
    // CR 510.4: the first-strike damage step only exists if something has first or double strike.
    if (step === 'first-strike-damage' && !needsFirstStrikeStep(next, next.combat)) step = 'combat-damage';

    next = { ...next, step };
    next = onEnterStep(next, step);
    if (next.pendingDiscard !== null) return next;
    // A combat declaration is owed: nobody holds priority until it is made.
    if (pendingDeclaration(next) !== null) return { ...next, priority: null, passed: [] };
    // Stop at the first step where somebody actually gets priority.
    if (!(NO_PRIORITY_STEPS as readonly string[]).includes(step)) {
      return resetPriority(next);
    }
  }
  return next;
}

/** What happens as a step begins, before anyone gets priority. */
function onEnterStep(state: GameState, step: Step): GameState {
  let next = state;
  switch (step) {
    case 'untap':
      next = untapAll(next, next.activeSeat);
      next = { ...next, landsPlayed: { ...next.landsPlayed, [String(next.activeSeat)]: 0 } };
      // "Until your next turn" ends here, before anybody can read the board it was changing —
      // which is the whole reason that duration exists. See `EffectDuration`.
      next = {
        ...next,
        effects: expireEffects(next, 'until-controllers-next-turn', next.activeSeat),
      };
      return next;

    case 'upkeep':
      return raise(next, { kind: 'step', step: 'upkeep' }, next.activeSeat);

    case 'draw':
      // The player who goes first skips their first draw (CR 103.8a).
      if (next.turn === 1) return next;
      return draw(next, next.activeSeat, 1);

    case 'declare-blockers': {
      // A defender with nothing that could legally block has no decision to make, so it is made
      // for them; otherwise the game would stop and wait for an answer with one option.
      const declared = [...next.combat.blockersDeclaredBy];
      for (const seat of new Set(next.combat.attacks.map((a) => a.defender))) {
        if (!declared.includes(seat) && legalBlockers(next, seat).length === 0) declared.push(seat);
      }
      return { ...next, combat: { ...next.combat, blockersDeclaredBy: declared } };
    }

    case 'first-strike-damage':
      if (!needsFirstStrikeStep(next, next.combat)) return next;
      next = dealCombatDamage(next, true);
      return { ...next, combat: { ...next.combat, firstStrikeDealt: true } };

    case 'combat-damage':
      if (next.combat.attacks.length === 0) return next;
      return dealCombatDamage(next, false);

    case 'end-combat':
      // "Until end of combat" is a duration the engine declared and nothing expired, which meant
      // an effect using it would have lasted the rest of the game. The step the name points at is
      // the only place it could ever have been dropped.
      return { ...next, combat: EMPTY_COMBAT, effects: expireEffects(next, 'end-of-combat') };

    case 'end':
      return raise(next, { kind: 'step', step: 'end' }, next.activeSeat);

    case 'cleanup': {
      // Hand size is a decision, so the engine stops and waits rather than discarding for them.
      const hand = listAt(next, zoneKey(next.activeSeat, 'hand'));
      if (hand.length > MAX_HAND_SIZE) {
        return { ...next, pendingDiscard: { seat: next.activeSeat, count: hand.length - MAX_HAND_SIZE } };
      }
      return endTurnCleanup(next);
    }

    default:
      return next;
  }
}

/** Damage wears off, until-end-of-turn effects end, and borrowed permanents go home. */
export function endTurnCleanup(state: GameState): GameState {
  let next = state;
  const instances = { ...next.instances };
  for (const [id, inst] of Object.entries(instances)) {
    // Damage wears off, deathtouch is forgotten, and a regeneration shield that was never spent
    // expires with the turn (CR 701.15b) — it is "the next time this turn", not a permanent save.
    const hasShield = inst.counters[REGENERATION] !== undefined;
    if (inst.damage !== 0 || inst.counters['deathtouched'] !== undefined || hasShield) {
      const counters = { ...inst.counters };
      delete counters['deathtouched'];
      delete counters[REGENERATION];
      instances[id] = { ...inst, damage: 0, counters };
    }
  }
  next = { ...next, instances };

  // Anything borrowed until end of turn is returned before the effect is dropped, or there would
  // be nothing left that knows where it came from.
  for (const effect of next.effects) {
    if (effect.duration !== 'end-of-turn' || effect.controlRevertTo === undefined) continue;
    if (effect.scope.kind !== 'cards') continue;
    for (const id of effect.scope.ids) {
      const inst = next.instances[id];
      if (inst === undefined || inst.zone !== 'battlefield') continue;
      next = relocate(next, inst, 'battlefield', effect.controlRevertTo, 'bottom');
    }
  }
  return { ...next, effects: expireEffects(next, 'end-of-turn'), pendingDiscard: null };
}

// ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

function triggerMatches(
  event: TriggerEvent, want: TriggerEvent, sourceSeat: SeatIndex, actorSeat: SeatIndex | undefined,
  isSubject = true,
): boolean {
  if (event.kind !== want.kind) return false;
  switch (want.kind) {
    case 'spell-cast': {
      const e = event as Extract<TriggerEvent, { kind: 'spell-cast' }>;
      const by = want.by ?? 'you';
      if (by === 'you' && actorSeat !== sourceSeat) return false;
      if (by === 'opponent' && actorSeat === sourceSeat) return false;
      const spell = want.spell ?? 'any';
      if (spell === 'any') return true;
      // The narrow one is answered from the spell's own types rather than from the broad
      // creature/noncreature split, so an artifact spell does not pass for "instant or sorcery".
      if (spell === 'instant-or-sorcery') {
        return (e.types ?? []).some((t) => t === 'instant' || t === 'sorcery');
      }
      return e.spell === spell;
    }
    case 'life-gained':
      return (want.by ?? 'you') === 'any' || actorSeat === sourceSeat;
    case 'step': {
      const e = event as Extract<TriggerEvent, { kind: 'step' }>;
      if (e.step !== want.step) return false;
      return (want.of ?? 'you') === 'any' || actorSeat === sourceSeat;
    }
    // The three events that are about one permanent and may still be watched by another. One
    // branch rather than three, because `who` and `of` have to mean the same thing on all of
    // them — a second copy of this filter is a second place for them to drift apart.
    case 'etb':
    case 'dies':
    case 'attacks': {
      // `self` is the default, which is why every script written before this one still means what
      // it meant: a trigger that says nothing about `who` watches only its own permanent.
      const who = want.who ?? 'self';
      if (who === 'self' && !isSubject) return false;
      if (who === 'another' && isSubject) return false;
      const e = event as { subjectSeat?: SeatIndex; subjectIsCreature?: boolean; subjectIsToken?: boolean };
      if (want.kind === 'dies' && want.nontoken === true && e.subjectIsToken === true) return false;
      // "a *creature* you control enters" is what the board-watchers say, and an enchantment
      // arriving is not that. Only asked for when the trigger asks for it, so a `self` trigger on
      // a non-creature permanent still fires for its own arrival. An attacker is a creature by
      // definition, which is why the attack event has no `what` to ask about.
      if (want.kind !== 'attacks' && (want.what ?? 'permanent') === 'creature'
        && e.subjectIsCreature !== true) return false;
      const of = want.of ?? 'any';
      if (of === 'any') return true;
      if (e.subjectSeat === undefined) return false;
      return of === 'you' ? e.subjectSeat === sourceSeat : e.subjectSeat !== sourceSeat;
    }
    case 'becomes-tapped':
    case 'leaves':
      return true;
    default:
      return false;
  }
}

/**
 * Puts every triggered ability that wants this event onto the stack.
 *
 * `subject` is the permanent the event happened to, for events that are about one object (a
 * creature entering, dying, attacking) — only that permanent's own triggers fire. `actor` is the
 * player who did it, for events that are about an action (casting a spell, gaining life).
 */
/**
 * Whether the engine passes priority for this seat when passing is all it can do.
 *
 * One answer to one question, for the three callers that ask it: the auto-pass loop, the per-seat
 * view, and the table's own toggle by way of that view. A seat missing from the list is on, which
 * also means a game stored before the list existed comes back with everybody auto-passing — the
 * default it had.
 */
export function autoPassFor(state: GameState, seat: SeatIndex): boolean {
  return !(state.autoPassOff ?? []).includes(seat);
}

/**
 * The seats in APNAP order: the active player, then everybody else in turn order (CR 101.4).
 *
 * The order simultaneous triggers are *put on* the stack, which is the reverse of the order they
 * resolve in — the active player's go on first and so resolve last (CR 603.3b). Before this the
 * engine walked seats by index, which gets the rule right only when the active player happens to
 * hold the lowest seat number: measured over 60 four-seat pods, 34 batches of simultaneous
 * triggers belonged to more than one player and 2 of them went on in the wrong order.
 *
 * Eliminated seats are kept out: a player who has left has no permanents and no triggers, and
 * including them would only make the order depend on how many people had already lost.
 */
function apnapSeats(state: GameState): SeatIndex[] {
  const live = state.seats.filter((s) => !s.eliminated).map((s) => s.index);
  if (live.length === 0) return state.seats.map((s) => s.index);
  const start = live.indexOf(state.activeSeat);
  // The active player may themselves be mid-elimination, in which case turn order from the next
  // live seat is the best reading there is.
  if (start < 0) return live;
  return [...live.slice(start), ...live.slice(0, start)];
}

function raise(
  state: GameState, event: TriggerEvent, actor?: SeatIndex, subject?: string,
): GameState {
  let next = state;
  if (subject !== undefined && (event.kind === 'etb' || event.kind === 'dies')) {
    // The event carries who controlled the permanent and whether it was a creature, so a watcher
    // can ask. Read from the subject rather than from `actor`, which for an entry is whoever cast
    // the spell and not always its controller.
    const inst = next.instances[subject];
    if (inst !== undefined) {
      event = {
        ...event,
        subjectSeat: inst.zoneSeat,
        subjectIsCreature: characteristicsOf(next, inst).isCreature,
        ...(event.kind === 'dies' ? { subjectIsToken: inst.isToken } : {}),
      };
    }
  }
  // Which permanents could have a trigger for this event.
  //
  // `becomes-tapped` and `leaves` are about one object and only that object's own script can care.
  // `etb`, `dies` and `attacks` usually are too — but "~ or another creature dies" is one of the
  // commonest black cards there is, and "whenever a creature you control attacks" is the same shape
  // one step along, so those three offer the event to every permanent on the battlefield and
  // `triggerMatches` decides from each trigger's own `who` whether it wants it. The subject is
  // always included: it may be the watcher, and for a death it is in a graveyard by now rather
  // than on the battlefield.
  const selfOnly = new Set(['becomes-tapped', 'leaves']);
  const everyBattlefield = apnapSeats(next).flatMap((seat) => {
    const mine = [...listAt(next, zoneKey(seat, 'battlefield'))].filter((id) => id !== subject);
    // The subject goes with its own controller rather than ahead of everybody: it may be the only
    // watcher, and after a death it is in a graveyard rather than on a battlefield, so it would
    // otherwise be missed. Put first within that seat, which is where it was.
    const subjectSeat = subject === undefined ? undefined : next.instances[subject]?.zoneSeat;
    return subjectSeat === seat ? [subject as string, ...mine] : mine;
  });
  const watchers = event.kind === 'etb' || event.kind === 'dies' || event.kind === 'attacks'
    ? everyBattlefield
    : selfOnly.has(event.kind)
      ? subject === undefined ? [] : [subject]
      : everyBattlefield;

  for (const id of watchers) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    // A `dies` trigger fires from the graveyard, but only for the creature that died: any other
    // watcher has to still be on the battlefield to be watching.
    // A `dies` or `leaves` trigger fires from wherever the permanent went, but only for the
    // permanent it happened to: any other watcher has to still be on the battlefield.
    const fromGraveyard = (event.kind === 'dies' || event.kind === 'leaves') && id === subject;
    if (!fromGraveyard && inst.zone !== 'battlefield') continue;
    const script = scriptOf(next, id);
    if (script?.triggers === undefined) continue;
    for (let i = 0; i < script.triggers.length; i++) {
      const trigger = script.triggers[i]!;
      if (!triggerMatches(event, trigger.on, inst.zoneSeat, actor, id === subject)) continue;
      const specs = trigger.targets ?? [];
      // Only an attack trigger has one, and only it needs one. See `StackObject.attacked`.
      const attacked = event.kind === 'attacks' ? event.attacked : undefined;
      if (specs.length === 0) {
        next = pushAbility(next, id, inst.zoneSeat, i, [], 'triggered', trigger.description, attacked);
        continue;
      }
      // A trigger that needs targets and has none legal is never put on the stack (CR 603.3c).
      if (!hasAnyLegalTargets(next, specs, inst.zoneSeat, id)) continue;
      const auto = obviousTargets(next, specs, inst.zoneSeat, id);
      next = pushAbility(
        next, id, inst.zoneSeat, i, auto ?? [], 'triggered', trigger.description, attacked,
      );
      if (auto !== null) continue;
      // Otherwise the controller chooses, and nothing happens until they do.
      const stackId = next.stackOrder[next.stackOrder.length - 1]!;
      next = {
        ...next,
        // As with `pendingDecision` above: nothing happens until it is answered, so nobody holds
        // priority. Leaving a seat named here is what let the *other* player's table offer a pass
        // the engine then refused.
        priority: null,
        passed: [],
        pendingChoice: {
          seat: inst.zoneSeat,
          stackId,
          description: trigger.description,
          remaining: specs.reduce((n, spec) => n + Math.max(1, spec.count ?? 1), 0),
        },
      };
    }
  }
  return next;
}

/**
 * The targets for a trigger when there is nothing to decide, or null when there is.
 *
 * A choice between one thing is not a choice: an ability that must target a creature when only one
 * creature exists has its target fixed by the rules, and stopping to ask would be a prompt with a
 * single button. Anything else goes to the controller — including "up to one" with a candidate,
 * because taking it or not is a real decision.
 */
function obviousTargets(
  state: GameState, specs: readonly TargetSpec[], controller: SeatIndex, source?: string,
): Target[] | null {
  const chosen: Target[] = [];
  for (const spec of specs) {
    const want = Math.max(1, spec.count ?? 1);
    if (spec.optional) return null;
    const available = legalTargets(state, spec, controller, source).filter(
      (t) => !chosen.some((c) => targetKey(c) === targetKey(t)),
    );
    if (available.length !== want) return null;
    chosen.push(...available);
  }
  return chosen;
}

function pushAbility(
  state: GameState, source: string, controller: SeatIndex, abilityIndex: number,
  targets: readonly Target[], kind: 'activated' | 'triggered', description: string,
  attacked?: AttackedTarget,
): GameState {
  const seq = state.autoSeq + 1;
  const id = `ab${seq}`;
  const inst = state.instances[source];
  const object: StackObject = {
    id, kind, source, controller,
    cardKey: inst?.defKey ?? '',
    abilityIndex, targets: [...targets], description,
    ...(attacked === undefined ? {} : { attacked }),
    targetSeqs: targetSeqsFor(state, targets),
  };
  return {
    ...state,
    autoSeq: seq,
    stackObjects: { ...state.stackObjects, [id]: object },
    stackOrder: [...state.stackOrder, id],
  };
}

// ── State-based actions ──────────────────────────────────────────────────────────────────────────

/**
 * The rules that check themselves, run after every action until nothing more changes (CR 704.3).
 *
 * The loop matters: a creature dying can remove an anthem, which can kill three more creatures, and
 * all of that has to settle before any player gets priority again.
 */
export function stateBasedActions(state: GameState): GameState {
  if (!state.automated) return state;
  let next = state;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;

    for (const seat of next.seats) {
      if (seat.eliminated) continue;
      if (next.drewFromEmpty.includes(seat.index)) {
        next = replaceSeat(next, seat.index, { eliminated: true, eliminatedReason: 'life' });
        changed = true;
      }
    }

    for (const seatRecord of next.seats) {
      for (const id of [...listAt(next, zoneKey(seatRecord.index, 'battlefield'))]) {
        const inst = next.instances[id];
        if (inst === undefined) continue;
        const ch = characteristicsOf(next, inst);

        // CR 704.5m: an Aura attached to nothing, or to something gone, is put into its owner's
        // graveyard. Both halves are needed, and the first is the one that bites: `relocate`
        // detaches an Aura when its host leaves the battlefield, so by the time this runs the Aura
        // is attached to *nothing* rather than to something illegal — checked for a gone host
        // alone, a Pacifism outlives the creature it was on and sits on the battlefield forever.
        if (hasSubtype(ch.typeLine, 'aura')) {
          const host = inst.attachedTo === null ? undefined : next.instances[inst.attachedTo];
          if (host === undefined || host.zone !== 'battlefield') {
            next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
            changed = true;
            continue;
          }
        }

        // CR 301.5c: an Equipment attached to something that is no longer a creature its
        // controller controls simply comes unattached — it stays on the battlefield, which is the
        // whole difference from an Aura and the reason equipment survives a board wipe. The bonus
        // has to go with the attachment, or a dead creature's +2/+0 would sit in `effects` for the
        // rest of the game, waiting to be applied to whatever next took that instance id.
        if (hasSubtype(ch.typeLine, 'equipment')) {
          const host = inst.attachedTo === null ? undefined : next.instances[inst.attachedTo];
          const stillLegal = host !== undefined && host.zone === 'battlefield'
            && host.zoneSeat === inst.zoneSeat && characteristicsOf(next, host).isCreature;
          // Checked on the *effect* as well as on the attachment, and that is the whole trick:
          // `relocate` detaches everything pointing at a card as it leaves, so by the time this
          // runs the Equipment is attached to nothing rather than to something dead. Reading only
          // `attachedTo` would find nothing wrong and leave the +2/+0 in `effects` forever —
          // exactly the shape of the Aura bug in D21, one card type along.
          const bonus = next.effects.some((e) => e.source === inst.id);
          if (!stillLegal && (inst.attachedTo !== null || bonus)) {
            next = removeEffectsFrom(withInstance(next, inst.id, { attachedTo: null }), inst.id);
            changed = true;
          }
        }

        // CR 704.5i: a planeswalker with no loyalty counters on it goes to its owner's
        // graveyard. Checked before the creature rules, because a planeswalker is not a creature
        // and would otherwise never be looked at again after it entered.
        if (hasType(ch.typeLine, 'planeswalker')) {
          if ((inst.counters['loyalty'] ?? 0) <= 0) {
            next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
            changed = true;
          }
          continue;
        }

        if (!ch.isCreature) continue;
        const lethal = ch.toughness <= 0 || inst.damage >= ch.toughness || inst.counters['deathtouched'] !== undefined;
        if (!lethal) continue;
        if (ch.keywords.has('indestructible') && ch.toughness > 0) continue;
        // A regeneration shield replaces this destruction (CR 701.15). Checked here as well as in
        // `destroy`, because most creatures die from damage rather than from a spell saying so —
        // a shield honoured only by `destroy` would save a creature from Doom Blade and not from
        // the 3/3 it was blocking, which is the half players actually use it for. A toughness of
        // zero or less is not destruction and cannot be regenerated away (CR 704.5a).
        if (ch.toughness > 0) {
          const saved = spendRegeneration(next, inst.id);
          if (saved !== null) {
            next = saved;
            changed = true;
            continue;
          }
        }
        // `relocate` records the death; `settle` raises it. See `AutomationState.died`.
        next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
        changed = true;
      }
    }

    // A permanent whose static effect source has left stops applying it.
    const live = expireEffects(next, 'never' as ContinuousEffect['duration']);
    if (live.length !== next.effects.length) {
      next = { ...next, effects: live };
      changed = true;
    }

    if (!changed) break;
  }
  return next;
}

/**
 * Runs state-based actions and raises the events the last action produced, until the game is quiet.
 *
 * Life gain is detected by comparing totals rather than being announced by whatever caused it,
 * which is the only way lifelink, a spell and an ability all reach the same trigger.
 */
/**
 * "If it would die, exile it instead", and anything else shaped like it (CR 614).
 *
 * The first replacement effect here that one permanent contributes for *another*. The two before it
 * — regeneration and "enters the battlefield tapped" — are shields sitting on the card they affect,
 * which is where they are printed; this one belongs to a permanent across the table.
 *
 * **Applied at the point the engine detects the death rather than before it happens, which is the
 * same answer `settle` already gives for "enters tapped" and for the same reason.** `relocate` is
 * the one place a card changes zone, and it *records* what happened rather than announcing it, so
 * the single list of what just died is here. The dying permanent therefore touches its graveyard
 * for the length of one function call before being moved on.
 *
 * What that costs, stated rather than glossed: a true replacement would mean the card was never in
 * the graveyard at all, and the only thing that could tell the difference is something reading a
 * graveyard *between* the move and this pass. Nothing does — the death event is raised below, after
 * this, so a replaced death is correctly not a death and triggers nothing; state-based actions do
 * not read graveyards; and no card in the pool asks. A card that counted creature cards in
 * graveyards as it resolved would be the one to break it, and would be the reason to move this
 * upstream into `relocate` with a hook, which is a bigger change than any card here earns.
 *
 * Several applicable replacements are not a choice the affected player is offered (CR 616.1); the
 * first in APNAP order wins. Nothing in this pool can produce two.
 */
function replaceDeaths(
  state: GameState, dying: readonly string[],
): { state: GameState; died: readonly string[] } {
  if (dying.length === 0) return { state, died: dying };
  const sources: { id: string; controller: SeatIndex }[] = [];
  for (const seat of apnapSeats(state)) {
    for (const id of listAt(state, zoneKey(seat, 'battlefield'))) sources.push({ id, controller: seat });
  }
  let next = state;
  const survived: string[] = [];
  for (const id of dying) {
    // A token has already ceased to exist by the time this runs, and every printed version of this
    // effect says "nontoken" anyway — so there is nothing to replace and nothing to look at.
    const inst = next.instances[id];
    if (inst === undefined) {
      survived.push(id);
      continue;
    }
    let handled = false;
    for (const source of sources) {
      if (next.instances[source.id]?.zone !== 'battlefield') continue;
      for (const rule of scriptOf(next, source.id)?.replaces ?? []) {
        if (rule.on !== 'dies') continue;
        const ctx = { state: next, dying: id, source: source.id, controller: source.controller };
        if (!rule.applies(ctx)) continue;
        const named = (of: string): string => next.cardDefs[next.instances[of]?.defKey ?? '']?.name ?? 'a card';
        const note = `${named(source.id)}: ${named(id)} — ${rule.description}`;
        next = rule.instead(ctx);
        // Said in words, because a replaced death raises no event and a creature that silently
        // turns up in exile is a card the player cannot see working. See `replacements`.
        next = { ...next, replacements: [...next.replacements, note] };
        handled = true;
        break;
      }
      if (handled) break;
    }
    if (!handled) survived.push(id);
  }
  return { state: next, died: survived };
}

function settle(state: GameState, before: GameState): GameState {
  let next = stateBasedActions(state);
  // Deaths and arrivals, in a loop: a creature dying can trigger something that kills another or
  // makes a token, and every one of those has to reach its own trigger. `relocate` and
  // `createToken` record them wherever they happen — lethal damage, a destroy spell, a sacrifice,
  // a reanimation, a token — and this is the only place they are announced, so no caller can
  // forget to. Deaths before arrivals in each pass, because a creature that dies and leaves
  // something behind should see the death trigger go on the stack first.
  for (
    let pass = 0;
    pass < 32 && (next.died.length > 0 || next.entered.length > 0 || next.left.length > 0);
    pass++
  ) {
    const replaced = replaceDeaths(next, next.died);
    next = replaced.state;
    const dead = replaced.died;
    const gone = next.left;
    const arrived = next.entered;
    next = { ...next, died: [], left: [], entered: [] };
    for (const id of dead) next = raise(next, { kind: 'dies' }, next.instances[id]?.zoneSeat, id);
    // Leaving comes after dying, so a card that does both raises the narrower event first and its
    // death trigger goes on the stack under the leave trigger — which is the order the rules put
    // them in for one event raising two abilities of the same controller.
    for (const id of gone) next = raise(next, { kind: 'leaves' }, next.instances[id]?.zoneSeat, id);
    for (const id of arrived) {
      const arrival = next.instances[id];
      if (arrival?.zone !== 'battlefield') continue;
      /*
        "Enters the battlefield tapped" is a replacement effect (CR 614.1c), not a trigger: the
        land was never untapped, so nobody could have tapped it for mana in between. Applied here,
        before the entry trigger is raised, which is as close to "never untapped" as a state the
        engine computes in one action can be — and the only way to be closer is a replacement
        layer the rest of the engine has no use for yet.
      */
      if (!arrival.tapped && scriptFor(next.cardDefs[arrival.defKey]?.name)?.entersTapped === true) {
        next = withInstance(next, id, { tapped: true });
      }
      next = raise(next, { kind: 'etb' }, next.instances[id]?.zoneSeat, id);
    }
    next = stateBasedActions(next);
  }
  /*
    Permanents that became tapped, found by comparing rather than announced by whatever tapped
    them — the same way deaths and arrivals are found, and for the same reason.

    "Whenever ~ becomes tapped" has to fire whether the permanent was tapped for mana, tapped by an
    Icy Manipulator or tapped by attacking, and none of those three paths should have to know the
    event exists. A mana ability does not use the stack (CR 605.3a) but a triggered ability that
    triggers off one does, which is exactly what a City of Brass is.

    A permanent that *entered* tapped did not become tapped, and the comparison gets that for free:
    it was not on the battlefield in `before` at all.
  */
  for (const key of Object.keys(next.zones)) {
    if (!key.endsWith(':battlefield')) continue;
    for (const id of next.zones[key] ?? []) {
      const now = next.instances[id];
      const was = before.instances[id];
      if (now === undefined || !now.tapped) continue;
      if (was === undefined || was.tapped || was.zone !== 'battlefield') continue;
      next = raise(next, { kind: 'becomes-tapped' }, now.zoneSeat, id);
    }
  }
  for (const seat of next.seats) {
    const was = before.seats[seat.index];
    if (was === undefined || seat.eliminated) continue;
    if (seat.life > was.life) next = raise(next, { kind: 'life-gained' }, seat.index);
  }
  return stateBasedActions(next);
}

// ── Casting, activating, resolving ───────────────────────────────────────────────────────────────


/**
 * Taps the chosen permanents and puts their mana in the pool.
 *
 * The life a painland charges is paid here, as the tap happens, because that is what it is: a cost
 * of the mana ability, not an effect of it (CR 118.4, CR 605.1a). Nothing goes on the stack and
 * nothing can be done about it — unlike City of Brass, whose damage is a trigger `settle` raises
 * off the tap itself and which therefore resolves like anything else.
 */
function tapSources(state: GameState, seat: SeatIndex, picks: readonly ManaPick[]): GameState {
  let next = state;
  for (const pick of picks) {
    next = withInstance(next, pick.key, { tapped: true });
    if (pick.life !== undefined) next = loseLife(next, seat, pick.life);
    // What the solver decided this one made — for a dual, the single colour it was tapped for.
    for (const type of pick.types) next = setPool(next, seat, addMana(poolOf(next, seat), type, 1));
  }
  return next;
}

/**
 * Pays a cost, tapping for it when the pool is short.
 *
 * Floating mana is spent first, so a player who tapped particular lands on purpose gets what they
 * intended; only the shortfall is tapped for. Auto-tapping is not a convenience — `legalActions`
 * offers a spell when the player *could* make its mana, so without this the engine would refuse a
 * play it had just offered.
 */
function payFrom(
  state: GameState, seat: SeatIndex, costText: string | undefined, x: number, extraGeneric = 0,
): { state: GameState; tapped: readonly string[] } {
  const printed = parseManaCost(costText);
  // `extraGeneric` is the commander tax (CR 903.8): generic mana on top of the printed cost, which
  // the card itself has not changed.
  const cost = extraGeneric > 0 ? { ...printed, generic: printed.generic + extraGeneric } : printed;
  let next = state;
  let tapped: readonly string[] = [];
  if (!canPay(poolOf(next, seat), cost, x)) {
    const sources = manaSources(next, seat);
    const plan = solveTap(poolOf(next, seat), cost, sources, x);
    if (plan !== null) {
      next = tapSources(next, seat, plan);
      tapped = plan.map((pick) => pick.key);
    }
  }
  const result = payCost(poolOf(next, seat), cost, x);
  if (!result.paid) {
    const shown = extraGeneric > 0 ? `${costText ?? '{0}'} +{${extraGeneric}}` : costText ?? '{0}';
    throw new EngineError('RULE_NOT_APPLICABLE', `cannot pay ${shown}: ${result.shortfall}`);
  }
  return { state: setPool(next, seat, result.pool as ManaPool), tapped };
}

// ── Modal spells ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every legal combination of modes for a modal script, in printed order.
 *
 * "Choose one" of three is three combinations; "choose one or both" of two is three; "choose two"
 * of four is six. Each comes back as sorted indices, because the modes of a modal spell apply in
 * the order they are printed whatever order the player picked them in (CR 601.2b).
 */
export function modeCombinations(script: CardScript | undefined): number[][] {
  const modal = script?.modal;
  if (modal === undefined || modal.modes.length === 0) return [];
  const total = modal.modes.length;
  const max = Math.min(modal.max ?? 1, total);
  const min = Math.min(Math.max(modal.min ?? 1, 1), max);
  const out: number[][] = [];
  const walk = (start: number, picked: number[]): void => {
    if (picked.length >= min) out.push([...picked]);
    if (picked.length >= max) return;
    for (let i = start; i < total; i++) walk(i + 1, [...picked, i]);
  };
  walk(0, []);
  // Shortest first, so "choose one or both" offers the simple answers before the compound one.
  return out.sort((a, b) => a.length - b.length || a[0]! - b[0]!);
}

/** The modes a stack object was cast with, or an empty list for anything not modal. */
export function modesOf(script: CardScript | undefined, modes: readonly number[] | undefined): ModeDef[] {
  if (script?.modal === undefined) return [];
  return (modes ?? []).map((i) => script.modal!.modes[i]).filter((m): m is ModeDef => m !== undefined);
}

/** The target specs a chosen set of modes wants, concatenated in printed order. */
export const modeTargetSpecs = (modes: readonly ModeDef[]): TargetSpec[] =>
  modes.flatMap((mode) => [...(mode.targets ?? [])]);

/**
 * Runs each chosen mode in printed order, handing each the targets that belong to it.
 *
 * Targets arrive as one flat list, in the order the specs were offered, so each mode takes the
 * next however-many. Getting this wrong would aim the second mode with the first mode's target.
 */
function runModes(
  state: GameState, modes: readonly ModeDef[], ctx: EffectContext,
): GameState {
  let next = state;
  let at = 0;
  let decided = 0;
  for (const mode of modes) {
    const wanted = (mode.targets ?? []).reduce((n, spec) => n + targetCount(spec), 0);
    const mine = ctx.targets.slice(at, at + wanted);
    at += wanted;
    const asks = (mode.decisions ?? []).length;
    const answers = ctx.decisions.slice(decided, decided + asks);
    decided += asks;
    next = mode.effect({ ...ctx, state: next, targets: mine, decisions: answers });
  }
  return next;
}

// ── Decisions made while something resolves ──────────────────────────────────────────────────────

/**
 * The questions a stack object asks while it resolves.
 *
 * Separate from its targets in every respect: asked later, possibly of somebody else, possibly
 * about cards in a hidden zone, and never answerable by an opponent. See `DecisionSpec`.
 */
function decisionSpecsFor(state: GameState, object: StackObject): readonly DecisionSpec[] {
  const script = scriptFor(state.cardDefs[object.cardKey]?.name);
  if (object.kind !== 'spell') return abilityOrTrigger(script, object)?.decisions ?? [];
  const modes = modesOf(script, object.modes);
  if (modes.length > 0) return modes.flatMap((mode) => [...(mode.decisions ?? [])]);
  return script?.decisions ?? [];
}

/** The half of a card that runs before its questions are asked. Spell-level only. */
function beforeDecisionsFor(state: GameState, object: StackObject): EffectFn | undefined {
  const script = scriptFor(state.cardDefs[object.cardKey]?.name);
  if (object.kind === 'spell') return script?.beforeDecisions;
  return abilityOrTrigger(script, object)?.beforeDecisions;
}

/**
 * Who answers each question, in order, with `each-opponent` expanded to one entry per opponent.
 *
 * Expanded up front rather than as it goes, so the plan is a fixed list the state can carry across
 * the gap between one action and the next — and so a player eliminated mid-resolution is not
 * suddenly asked something. `target-player` with no player target asks nobody, which is not an
 * error: the spell simply has nothing to ask.
 */
function decisionPlan(
  state: GameState, specs: readonly DecisionSpec[], object: StackObject,
): { seat: SeatIndex; specIndex: number }[] {
  const plan: { seat: SeatIndex; specIndex: number }[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (spec.who === 'controller') {
      plan.push({ seat: object.controller, specIndex: i });
      continue;
    }
    if (spec.who === 'target-player') {
      const target = object.targets.find((t) => t.kind === 'player');
      if (target !== undefined && target.kind === 'player') plan.push({ seat: target.seat, specIndex: i });
      continue;
    }
    for (const seat of turnOrder(state)) {
      if (spec.who === 'each-opponent' && seat === object.controller) continue;
      plan.push({ seat, specIndex: i });
    }
  }
  return plan;
}

/**
 * Living seats in turn order from the active player (CR 101.4).
 *
 * Which is the order "each player sacrifices a creature" asks in, and that order is sometimes the
 * whole card: the second player to answer has seen what the first gave up.
 */
function turnOrder(state: GameState): SeatIndex[] {
  const alive = state.seats.filter((s) => !s.eliminated).map((s) => s.index);
  const start = alive.indexOf(state.activeSeat);
  return start < 0 ? alive : [...alive.slice(start), ...alive.slice(0, start)];
}

/** The cards in the chooser's own zone that a decision would accept. */
export function decisionCandidates(
  state: GameState, spec: DecisionSpec, chooser: SeatIndex,
): string[] {
  // `library-top` is the top few cards of the chooser's own library rather than a whole zone —
  // scry looks at two cards, not at fifty-three, and the candidate list is also the authorisation
  // the answer is checked against, so taking the slice here is what stops a crafted answer
  // reaching the rest of the deck.
  const inZone = spec.from === 'library-top'
    ? listAt(state, zoneKey(chooser, 'library')).slice(0, Math.max(0, spec.look ?? 1))
    : listAt(state, zoneKey(chooser, spec.from));
  return inZone.filter((id) => {
    if (state.instances[id] === undefined) return false;
    return spec.filter === undefined || spec.filter(state, id, chooser);
  });
}

/** How many a decision asks for, clamped to what the chooser actually has. */
function decisionBounds(spec: DecisionSpec, available: number): { min: number; max: number } {
  const max = Math.min(spec.max ?? 1, available);
  return { min: Math.min(spec.min ?? 1, max), max };
}

/**
 * Asks the next question in a resolution's plan, or finishes the resolution when they run out.
 *
 * Two kinds of question are answered by the engine rather than asked, and both matter:
 *
 *  - **Nothing to choose from.** "Each opponent sacrifices a creature" asks nothing of an opponent
 *    who controls none. Asking would put a prompt on their screen with no button that answers it,
 *    which is a stopped game — the exact failure the graveyard-targeting bug produced.
 *  - **Exactly the number it must take.** A player discarding two cards with two cards in hand has
 *    no decision to make. A prompt with one possible answer is noise, and in a solo game it is a
 *    prompt the player has to click through for no reason.
 *
 * Anything else is a real decision, and the game stops until it is answered. A library decision is
 * a search, so the chooser is allowed to look through their library while they decide.
 */
function askOrFinish(
  state: GameState, object: StackObject,
  plan: readonly { seat: SeatIndex; specIndex: number }[], from: number,
  soFar: readonly DecisionAnswer[],
): { state: GameState; message: string } {
  const specs = decisionSpecsFor(state, object);
  let answers = soFar;
  for (let i = from; i < plan.length; i++) {
    const entry = plan[i]!;
    const spec = specs[entry.specIndex];
    if (spec === undefined) continue;
    // A seat that has left the game between one question and the next is not asked.
    if (state.seats[entry.seat]?.eliminated !== false) {
      answers = [...answers, { seat: entry.seat, ids: [] }];
      continue;
    }
    // Nothing already chosen by this seat earlier in the same resolution. Answers are applied by
    // the effect at the end, not as the questions are asked — which is right, because "each player
    // sacrifices a creature" is simultaneous and the second player must not see the first's
    // creature already gone. The consequence is that two questions put to the *same* seat from the
    // same zone would otherwise offer the same card twice, so they are taken out here.
    const taken = new Set(answers.filter((a) => a.seat === entry.seat).flatMap((a) => [...a.ids]));
    const candidates = decisionCandidates(state, spec, entry.seat).filter((id) => !taken.has(id));
    const { min, max } = decisionBounds(spec, candidates.length);
    if (max === 0 || (min === max && candidates.length === max)) {
      answers = [...answers, { seat: entry.seat, ids: max === 0 ? [] : candidates }];
      continue;
    }
    const asking: GameState = {
      ...state,
      // Nobody holds priority in the middle of a resolution, and saying so is not cosmetic: a
      // state that still names a seat makes that seat's table offer Pass, the engine refuses it
      // because a question is outstanding, and the two disagree for as long as the question
      // stands. Found exactly that way, in two browsers, on turn ten.
      priority: null,
      passed: [],
      pendingDecision: {
        seat: entry.seat, stackId: object.id, prompt: spec.prompt,
        candidates, min, max, from: spec.from,
        resume: { plan: [...plan], at: i, answers: [...answers] },
      },
    };
    return {
      // Searching a library is allowed to look at it, which is what a real search is. Scry needs
      // no flag: the top cards are readable because they are on the question, and `canIdentify`
      // reads the same list.
      state: spec.from === 'library' ? replaceSeat(asking, entry.seat, { searching: true }) : asking,
      message: `${object.description} — ${seatName(state, entry.seat)}: ${spec.prompt}`,
    };
  }
  return completeResolution(state, object, answers);
}

/**
 * Records an answer and carries the resolution on.
 *
 * Validation is the caller's; this is the part that has to be right about the library. A search
 * ends by shuffling (CR 701.19e), which is both what the cards say and what stops the chooser
 * keeping the order they were just shown — and it closes the view onto their own library, because
 * `searching` is the only thing that opens it.
 */
export function answerDecision(
  state: GameState, chosen: readonly string[],
): { state: GameState; message: string } {
  const pending = state.pendingDecision;
  if (pending === null) return { state, message: 'nothing to decide' };
  const object = state.stackObjects[pending.stackId];
  let next: GameState = { ...state, pendingDecision: null };
  if (pending.from === 'library') {
    const key = zoneKey(pending.seat, 'library');
    const rng = mulberry32(actionSeed(next.rngSeed, next.stateVersion + next.autoSeq));
    next = replaceSeat(withZones(next, { [key]: shuffled(listAt(next, key), rng) }), pending.seat, {
      searching: false,
    });
  }
  // Scry: the cards chosen go to the bottom and the rest stay on top, in the order they were
  // already in. Done here rather than by the card, because putting them back is part of the
  // keyword and not part of what the spell does afterwards — Preordain's own effect is the draw.
  // No shuffle: a scry that shuffled would be a very different card.
  if (pending.from === 'library-top') {
    const key = zoneKey(pending.seat, 'library');
    const bottomed = chosen.filter((id) => pending.candidates.includes(id));
    if (bottomed.length > 0) {
      const rest = listAt(next, key).filter((id) => !bottomed.includes(id));
      next = withZones(next, { [key]: [...rest, ...bottomed] });
    }
  }
  // The object leaving the stack mid-resolution should not be possible — nothing else can happen
  // while a decision is outstanding — but a resolution with nothing to resolve is simply over.
  if (object === undefined) return { state: next, message: 'that resolution is gone' };
  const answers = [...pending.resume.answers, { seat: pending.seat, ids: [...chosen] }];
  return askOrFinish(next, object, pending.resume.plan, pending.resume.at + 1, answers);
}

/** Takes a stack object off the stack, which is the first thing resolving it does. */
function popStack(state: GameState, id: string): GameState {
  const objects = { ...state.stackObjects };
  delete objects[id];
  return { ...state, stackObjects: objects, stackOrder: state.stackOrder.filter((o) => o !== id) };
}

/** The target specs a stack object was pointed with, for the fizzle check. */
export function targetSpecsFor(
  state: GameState, script: CardScript | undefined, object: StackObject,
): readonly TargetSpec[] {
  if (object.kind !== 'spell') return abilityOrTrigger(script, object)?.targets ?? [];
  const modes = modesOf(script, object.modes);
  if (modes.length > 0) return modeTargetSpecs(modes);
  return script?.targets ?? (script?.aura ? [script.aura.target] : []);
}

/**
 * Begins resolving the object on top of the stack.
 *
 * Three outcomes. It is countered for having no legal target left (CR 608.2b); it stops to ask
 * somebody a question, in which case it is still on the stack and `pendingDecision` is set; or it
 * resolves there and then, which is what almost everything does.
 */
export function resolveTop(state: GameState): { state: GameState; message: string } {
  let object = stackTop(state);
  if (object === undefined) return { state, message: 'nothing to resolve' };

  const script = scriptFor(state.cardDefs[object.cardKey]?.name);
  const specs = targetSpecsFor(state, script, object);

  /*
    A target that is no longer the object it was chosen as is gone, however legal it looks.

    Dropped before the fizzle check rather than inside it, so that a spell with two targets that
    lost one resolves against the one it still has and the effect never sees the other. This is
    what makes a Cloudshift in response to a Doom Blade do what the card is for.
  */
  const chosen = object.targets;
  const live = liveTargets(state, chosen, object.targetSeqs);
  if (live.length !== chosen.length) {
    object = { ...object, targets: live };
    state = { ...state, stackObjects: { ...state.stackObjects, [object.id]: object } };
  }

  /*
    A spell or ability whose targets have all become illegal does not resolve at all (CR 608.2b).

    "Chose nothing" and "lost everything it chose" are different: a spell with an optional target
    that was pointed at nothing resolves, and one whose only target is gone is countered — which is
    why the count it started with decides, rather than the list that is left.
  */
  const hasTarget = chosen.length === 0
    || (live.length > 0 && stillHasLegalTarget(state, specs, live, object.controller, object.source));
  if (specs.length > 0 && !hasTarget) {
    let next = popStack(state, object.id);
    const name = next.cardDefs[object.cardKey]?.name ?? 'it';
    if (object.kind === 'spell') {
      const inst = next.instances[object.id];
      if (inst !== undefined) next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
    }
    return { state: next, message: `${name} is countered: its targets are gone` };
  }

  const wanted = decisionSpecsFor(state, object);
  if (wanted.length > 0) {
    // The half of the card that comes before its question. See `CardScript.beforeDecisions`.
    const first = beforeDecisionsFor(state, object);
    const ready = first === undefined ? state : first({
      state, source: object.kind === 'spell' ? object.id : object.source,
      controller: object.controller, targets: object.targets, x: object.x ?? 0, decisions: [],
      kicked: object.kicked === true, attacked: object.attacked,
    });
    return askOrFinish(ready, object, decisionPlan(ready, wanted, object), 0, []);
  }
  return completeResolution(state, object, []);
}

/** Finishes a resolution: the effect runs, and a permanent arrives on the battlefield. */
function completeResolution(
  state: GameState, object: StackObject, answers: readonly DecisionAnswer[],
): { state: GameState; message: string } {
  let next = popStack({ ...state, pendingDecision: null }, object.id);
  const script = scriptFor(next.cardDefs[object.cardKey]?.name);

  const ctx: EffectContext = {
    state: next,
    source: object.kind === 'spell' ? object.id : object.source,
    controller: object.controller,
    targets: object.targets,
    x: object.x ?? 0,
    decisions: answers,
    kicked: object.kicked === true,
    attacked: object.attacked,
  };

  if (object.kind === 'spell') {
    const inst = next.instances[object.id];
    const def = next.cardDefs[object.cardKey];
    const isPermanent = inst !== undefined && isPermanentCard(def);
    const modes = modesOf(script, object.modes);
    // A modal spell's effect is its chosen modes, in printed order; everything else has one.
    if (modes.length > 0) next = runModes(next, modes, { ...ctx, state: next });
    else if (script?.onResolve) next = script.onResolve({ ...ctx, state: next });
    if (isPermanent && inst !== undefined) {
      next = relocate(next, requireInstance(next, inst.id), 'battlefield', object.controller, 'bottom');
      /*
        "Enters the battlefield with N +1/+1 counters on it" (CR 614.1c), applied here because
        this is the only place the X it was cast for is known: a creature put onto the battlefield
        by something else — reanimated, or made as a token — enters with X of zero, which is what
        the rules say rather than a simplification.
      */
      const arrives = script?.entersWith;
      if (arrives !== undefined) {
        const amount = arrives.amount === 'x' ? (object.x ?? 0) : arrives.amount;
        if (amount > 0) next = addCounters(next, inst.id, arrives.counter, amount);
      }
      if (script?.aura) {
        const host = object.targets.find((t) => t.kind === 'card');
        if (host && host.kind === 'card') {
          next = withInstance(next, inst.id, { attachedTo: host.id });
          next = addAuraEffect(next, inst.id, object.controller, host.id, script);
        }
      }
      // `relocate` above recorded the arrival; `settle` announces it. See `AutomationState.entered`.
      next = applyStatics(next, inst.id, object.controller, script);
    } else if (inst !== undefined) {
      next = relocate(next, requireInstance(next, inst.id), 'graveyard', inst.owner, 'bottom');
    }
    const name = def?.name ?? 'a spell';
    return { state: next, message: script ? `${name} resolves` : `${name} resolves (not automated — resolve it by hand)` };
  }

  const ability = abilityOrTrigger(script, object);
  if (ability?.effect) next = ability.effect({ ...ctx, state: next });
  const label = object.description || 'an ability';
  return { state: next, message: `${label} resolves` };
}

/** An activated ability and a triggered one resolve the same way: targets, then an effect. */
interface Resolvable {
  readonly targets?: readonly TargetSpec[];
  readonly decisions?: readonly DecisionSpec[];
  readonly beforeDecisions?: EffectFn;
  readonly effect?: EffectFn;
}

function abilityOrTrigger(script: CardScript | undefined, object: StackObject): Resolvable | undefined {
  if (script === undefined || object.abilityIndex === undefined) return undefined;
  if (object.kind === 'activated') return script.abilities?.[object.abilityIndex];
  return script.triggers?.[object.abilityIndex];
}

const PERMANENT_TYPES = ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'battle'];
function isPermanentCard(def: CardDef | undefined): boolean {
  const line = (def?.typeLine ?? '').toLowerCase();
  return PERMANENT_TYPES.some((t) => line.includes(t));
}

function addAuraEffect(
  state: GameState, auraId: string, controller: SeatIndex, hostId: string, script: CardScript,
): GameState {
  if (!script.aura) return state;
  const seq = state.autoSeq + 1;
  const effect: ContinuousEffect = {
    id: `fx${seq}`, source: auraId, controller,
    scope: { kind: 'cards', ids: [hostId] },
    duration: 'permanent', createdTurn: state.turn,
    ...modsFrom(script.aura.effect),
  };
  return { ...state, autoSeq: seq, effects: [...state.effects, effect] };
}

function applyStatics(
  state: GameState, id: string, controller: SeatIndex, script: CardScript | undefined,
): GameState {
  let next = state;
  for (const entry of script?.statics ?? []) {
    const seq = next.autoSeq + 1;
    const scope: ContinuousEffect['scope'] =
      entry.scope === 'self' ? { kind: 'cards', ids: [id] }
      : entry.scope === 'controller-creatures' ? { kind: 'controller-creatures' }
      : entry.scope === 'other-controller-creatures' ? { kind: 'other-controller-creatures' }
      : { kind: 'all-creatures' };
    next = {
      ...next,
      autoSeq: seq,
      effects: [...next.effects, {
        id: `fx${seq}`, source: id, controller, scope, duration: 'permanent', createdTurn: next.turn,
        ...modsFrom(entry.effect),
      }],
    };
  }
  return next;
}

export { legalTargets, hasAnyLegalTargets, checkTargets, scriptOf, raise, nextAlive, prevAlive, aliveSeats, resetPriority, advanceStep, payFrom, pushAbility, settle, attackAimIssue, canAttack, canBlock, damageOrderChoice, damageOrdersOwed, forcedAttackers, legalAttackers, legalBlockers, legalDefenders, menaceSatisfied, needsFirstStrikeStep, tapAttackers, destroy, STEP_LABELS };
