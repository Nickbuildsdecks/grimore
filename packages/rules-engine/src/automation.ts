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
  allAbilitiesLost, characteristicsOf, expireEffects, grantedTriggersOn, hasSubtype, hasType,
  isLegendary,
  type ContinuousEffect, type GrantedTriggerRef,
} from './characteristics.js';
import {
  isFaceDownObject, isFaceDownPermanent, zoneKey, type CardDef, type CardInstance,
} from './cards.js';
import { listAt, relocate, requireInstance, withInstance, withZones } from './cardActions.js';
import {
  attackAimIssue, canAttack, canBlock, damageOrderChoice, damageOrdersOwed, dealCombatDamage,
  forcedAttackers, legalAttackers, legalBlockers, legalDefenders, menaceSatisfied,
  needsFirstStrikeStep, tapAttackers,
} from './combat.js';
import {
  DASHED, EVOKED, MYRIAD, REGENERATION, SEAT_CHOICE, TIME, addCounters, breakEndedPairs,
  counterSpell, destroy,
  recordExpiry,
  draw,
  drawLater, energyOf, exileCard, loseLife, mill, moveToGraveyard, spendEnergy, suspendedCast,
  madnessOffer, miracleOffer,
  modsFrom, poolOf, pump, removeEffectsFrom, scheduleDelayed, setPool, spellLeavesStack,
  spendRegeneration, untapAll,
  type EffectContext, type EffectFn, type PumpOptions,
} from './effects.js';
import { legalActions, manaSources } from './legalActions.js';
import { EngineError, type GameState, type Outcome, type SeatIndex } from './types.js';
import {
  EMPTY_POOL, addMana, canAfford, canPay, parseManaCost, payCost, solveTap,
  type ManaCost, type ManaPick, type ManaPool, type ManaType,
} from './mana.js';
import { actionSeed, mulberry32, replaceSeat, seatName, shuffled } from './internal.js';
import { scriptFor, soleTargetSpecOf } from './scripts.js';
import { scriptForCard } from './derive.js';
import type {
  AbilityCost, AbilityDef, CardScript, CardsDecisionSpec, ConditionFn, CountersDecisionSpec,
  DecisionSpec, DecisionSpecOf, ModeDef, ReplacementEvent, TargetSpec, TriggerDef, TriggerEvent,
} from './scriptTypes.js';
import {
  isCardsDecision, isChoiceDecision, isCountersDecision, isNumberDecision, isTargetDecision,
  targetCount,
} from './scriptTypes.js';
import {
  BESTOW_TARGET, checkTargets, hasAnyLegalTargets, isLegalAttachment, legalTargets, liveTargets,
  stillHasLegalTarget, stillTheObject, targetSeqsFor,
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
    if (inst === undefined) return false;
    const ch = characteristicsOf(state, inst);
    /*
      An artifact cost eats artifacts, and an artifact **creature** counts for both: a card that is
      both is both (CR 205.2b). Read off `characteristicsOf` rather than the printed type line, so a
      land animated into an artifact creature is eligible and a Mutavault is not.

      Note what this *does* include: the source itself. An Arcbound Ravager is an artifact, and
      sacrificing it to its own ability is a legal if pointless play — the printed card says
      "sacrifice an artifact", not "another artifact", and refusing it here would be the engine
      inventing a restriction. The bot will not do it, because feeding the thing you are growing is
      never the cheapest creature it could feed.
    */
    return cost.sacrifice === 'artifact' ? hasType(ch.typeLine, 'artifact') : ch.isCreature;
  });
}

/**
 * Attackers this seat controls that nothing is blocking — ninjutsu's candidates (CR 702.49a).
 *
 * Read off `combat.attacks` rather than off the battlefield, because "unblocked attacker" is a fact
 * about the combat and not about the creature: a 2/2 sitting at home is not one, and a 2/2 that was
 * blocked and whose blocker has since died **still is not one**, because the `blockers` list is
 * what says an attack is blocked and nothing is removed from it (CR 509.1h).
 *
 * **And the defending seat has to have finished declaring**, which is an explicit check rather than
 * a consequence: `blockers` starts empty on every attack, so an attacker is not "unblocked" the
 * moment it is declared — it is unblocked once the player who could have blocked it has said they
 * did not. Without that line a ninja could be swapped in during the declare-attackers step, before
 * the defender had any say, which is the opposite of what the keyword is for.
 *
 * So this is the timing check as well as the candidate list, which is the shape every other cost
 * here has: the one fact the cost needs is the one fact that says when it may be paid.
 */
export function unblockedAttackersOf(state: GameState, seat: SeatIndex): string[] {
  return state.combat.attacks
    .filter((attack) => attack.blockers.length === 0
      && state.combat.blockersDeclaredBy.includes(attack.defender)
      && state.instances[attack.attacker]?.zoneSeat === seat
      && state.instances[attack.attacker]?.zone === 'battlefield')
    .map((attack) => attack.attacker);
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
  /*
    Nothing is outstanding on a finished game (CR 104.1), and this is the one outstanding thing the
    game-over block in `engine.ts` cannot clear for itself.

    Every other question the engine can be holding is a **field** — a decision, a choice, a ward
    payment, an offered cast, a discard — and the block that ends the game sets each of them to
    null. A combat declaration is not a field: it is derived here from the step and the combat
    record, so a game that ended while somebody still owed attackers or blockers kept asking for
    them forever. The table reads it as a game-over screen that is also demanding a declaration,
    and `legalActions` offers nothing else while one is outstanding, so there is no way out of it.
  */
  if (state.finished) return null;
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

/**
 * "Whenever ~ attacks and isn't blocked" for every attacker nobody blocked (CR 509.1h).
 *
 * One function with two callers, because a seat can come to have declared blockers in two
 * different ways: it said so (`auto:block`), or it had nothing that could legally block and the
 * step said so for it. Each caller asks only once — whichever of them leaves no blocker
 * declaration outstanding is the one that raises — so an attacker's trigger fires exactly once
 * however the blocks came in.
 *
 * Not called when a declaration is still owed: in a pod one defender's blocks say nothing about
 * whether another is about to block the same creature.
 */
export function raiseUnblockedAttacks(state: GameState): GameState {
  if (pendingDeclaration(state)?.kind === 'blockers') return state;
  let next = state;
  for (const attack of state.combat.attacks) {
    if (attack.blockers.length > 0) continue;
    next = raise(
      next,
      {
        kind: 'attacks-unblocked',
        subjectSeat: state.activeSeat,
        attacked: {
          defender: attack.defender,
          ...(attack.planeswalker === undefined ? {} : { planeswalker: attack.planeswalker }),
        },
      },
      state.activeSeat,
      attack.attacker,
    );
  }
  return next;
}

/**
 * Puts every delayed trigger this step is the moment for onto the stack, once each (CR 603.7).
 *
 * Called on entering every step rather than only the two that cards currently name, because the
 * mechanism is about *a* step and a card that says "at the beginning of the next upkeep" would
 * otherwise need a second place to be remembered.
 *
 * Three rules worth naming. It fires **once**: the entry is dropped whether or not the ability
 * does anything, because the trigger has happened. It fires from wherever its source has got to —
 * a Flickerwisp destroyed before the end step still gives the card back, because the delayed
 * ability stopped belonging to it the moment it was created (CR 603.7d). And "the **next**" one
 * cannot be the step it was created in: a delayed trigger made during an end step waits for the
 * following turn's (CR 603.7b).
 */
function fireDelayed(state: GameState, step: Step): GameState {
  if (state.delayed.length === 0) return state;
  const due = state.delayed.filter((entry) => {
    if (entry.step !== step) return false;
    if (entry.of === 'you' && state.activeSeat !== entry.controller) return false;
    return !(entry.createdTurn === state.turn && entry.createdStep === step);
  });
  if (due.length === 0) return state;
  let next: GameState = { ...state, delayed: state.delayed.filter((e) => !due.includes(e)) };
  for (const entry of due) {
    /*
      "That creature" is the object the ability was scheduled about, not whatever now wears its id
      (CR 400.7).

      `relocate` hands a card back its own instance id, so a creature blinked out and straight back
      reads as present — and a Thicket Basilisk's "destroy the creature it fought" killed the
      Cloudshifted blocker that the rules say it can no longer find. The entry still fires, because
      the trigger has happened (CR 603.7d); what it loses is its subject, and every effect that
      reads one already does nothing without it. See `DelayedTrigger.subjectSeq`.
    */
    const sameObject = entry.subject === undefined || entry.subjectSeq === undefined
      || (next.instances[entry.subject]?.objectSeq ?? 0) === entry.subjectSeq;
    next = pushAbility(
      next, entry.source, entry.controller, entry.abilityIndex, [], 'triggered', entry.description,
      entry.subject === undefined || !sameObject ? {} : { subject: entry.subject },
    );
  }
  return next;
}

export const stackTop = (state: GameState): StackObject | undefined => {
  const id = state.stackOrder[state.stackOrder.length - 1];
  return id === undefined ? undefined : state.stackObjects[id];
};

/**
 * Which of a dash card's triggers is the return to hand.
 *
 * Found rather than declared, the way unearth's `delayedIndexOf` finds its exile: a delayed trigger
 * is scheduled by index, and an index written beside the keyword is an index that eventually
 * disagrees with the list it points into. A card with dash carries exactly one `delayed` trigger —
 * `dashReturn()` is what builds it, and a test holds the rule — so the search cannot be ambiguous
 * for anything in this pool.
 */
const dashReturnIndex = (script: CardScript | undefined): number =>
  (script?.triggers ?? []).findIndex((trigger) => trigger.delayed === true
    && trigger.on.kind === 'step' && trigger.on.step === 'end');

/** Rebound's own delayed trigger, the same arrangement one step of the turn earlier. */
const reboundCastIndex = (script: CardScript | undefined): number =>
  (script?.triggers ?? []).findIndex((trigger) => trigger.delayed === true
    && trigger.on.kind === 'step' && trigger.on.step === 'upkeep');

const scriptOf = (state: GameState, instanceId: string): CardScript | undefined => {
  const inst = state.instances[instanceId];
  if (inst === undefined || isFaceDownPermanent(inst)) return undefined;
  /*
    `scriptForCard` rather than `scriptFor`, so a permanent nobody wrote a script for still has the
    abilities its own data states — which for a land means the mana ability that is the whole card.
    A hand-written script always wins, so every card in the pool reads exactly as before. This is
    the chokepoint every activation goes through, which is why it is the one that had to change:
    without it a derived land would be *offered* in `legalActions` and then refused here.
  */
  return scriptForCard(state.cardDefs[inst.defKey]);
};

/**
 * The script of what a stack object is, or none while it is a face-down spell (CR 707.4).
 *
 * The stack's counterpart to `scriptOf`, and for the same reason: a face-down creature spell has no
 * text, so it has no targets to check, no questions to ask, no effect to run on resolution and no
 * "enters with counters" clause. Four readers in this file ask for a stack object's script and all
 * four go through here, because a face-down spell that resolved with its card's `onResolve` would
 * be a morph that did the card's trick for {3} and then sat there as a 2/2.
 *
 * An ability on the stack is never face down: it has no card of its own, and `instances[object.id]`
 * is undefined for it, which is why the check is on the instance rather than on the kind.
 */
const scriptOnStack = (state: GameState, object: StackObject): CardScript | undefined => {
  const inst = state.instances[object.id];
  if (inst !== undefined && isFaceDownObject(inst)) return undefined;
  /*
    `scriptForCard`, for the same reason `scriptOf` above uses it — and this is the one that was
    missed, which cost a derived cycling land its cantrip.

    The first wiring covered the *battlefield* lookups: offering an ability, paying for it,
    arriving tapped. It did not cover this one, and the symptom is the worst shape available: the
    ability was offered correctly, the cost was paid, the card went to the graveyard, the ability
    went on the stack, it resolved — and nothing happened, because the script this looks the
    `effect` up in was the hand-written registry, which has no entry for a derived card. No error,
    no refusal, a card that silently did half of what it reads.

    An ability on the stack is also the *only* lookup that can reach a card no longer in play: a
    cycling cost discards the card as it is activated, so by the time this runs the only thing left
    is `cardDefs[object.cardKey]`. That is exactly what `scriptForCard` takes.
  */
  return scriptForCard(state.cardDefs[object.cardKey]);
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
    || state.pendingPayment !== null || state.pendingOfferedCast !== null
    || state.pendingDredge !== null
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
    /*
      The step says so, for **every** step rather than for the two that happened to have a card
      (D434).

      `onEnterStep` used to raise this itself, from inside its `upkeep` and `end` cases, and the
      other eleven steps raised nothing. That was invisible for as long as the only cards asking
      were an upkeep card and an end-step card — and the compiler then started reading
      "At the beginning of combat on your turn" (262 legal corpus lines) and "At the beginning of
      your draw step" (18). Those cards compiled with `unread: []`, reported fully automated, and
      did nothing whatsoever, because no `begin-combat` or `draw` step event has ever existed. A
      probe confirmed it before this line was written: a compiled Luminarch Aspirant reached
      declare-attackers with no counter on anything, nothing on the stack and nothing in the log.

      So it is raised here, once, after the step's own turn-based action and before `fireDelayed` —
      which is the printed order either way: the untap, the draw, the lore counter and the
      monarch's card all happen as the step begins, and what triggers on the step goes on the stack
      after them.

      Every step, including `untap` and `cleanup`, which no prologue reads: a trigger raised in a
      step where nobody receives priority simply waits for the next step that grants it, which is
      the rule (CR 503.1). A list of "the steps a card can name" would be a second thing to keep in
      step with `TRIGGER_SHAPES`, and D433 is the entry about what two statements of one fact cost.
    */
    next = raise(next, { kind: 'step', step }, next.activeSeat);
    // And anything that was scheduled for this step, after the step's own turn-based action: an
    // "at end of combat" ability goes on the stack in the end-of-combat step and is responded to
    // there, like any other trigger. See `fireDelayed`.
    next = fireDelayed(next, step);
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

/**
 * How many chapters a Saga has, read off its own abilities.
 *
 * Derived rather than declared, which is the whole reason `saga` is a flag: a `chapters: 3` field
 * sitting beside the chapter triggers is a field that eventually disagrees with them, and the
 * consequence would be a Saga that never leaves or one that leaves a turn early.
 */
export const sagaChapters = (script: CardScript | undefined): number => {
  if (script?.saga !== true) return 0;
  let last = 0;
  for (const trigger of script.triggers ?? []) {
    if (trigger.on.kind === 'chapter') last = Math.max(last, trigger.on.n);
  }
  return last;
};

/**
 * Puts a lore counter on a Saga and raises the chapter that number means (CR 714.2b).
 *
 * One at a time, and raising per counter rather than per call, because the two are not the same
 * question: something that put two lore counters on a Saga at once would trigger both chapters, in
 * order, which is the rule. Nothing in this pool does that, and writing it the other way would
 * have been a decision to get wrong later for no saving now.
 *
 * The *counter* is the state and the chapter is what reaching a number means. That is why there is
 * no bookkeeping of which chapters have fired: the number on the card is the record.
 */
function addLore(state: GameState, id: string, amount = 1): GameState {
  let next = state;
  for (let i = 0; i < amount; i++) {
    const inst = next.instances[id];
    if (inst === undefined || inst.zone !== 'battlefield') break;
    const reached = (inst.counters['lore'] ?? 0) + 1;
    next = addCounters(next, id, 'lore', 1);
    next = raise(next, { kind: 'chapter', n: reached }, inst.zoneSeat, id);
  }
  return next;
}

/** A lore counter on each Saga this seat controls, as its precombat main phase begins. */
function advanceSagas(state: GameState, seat: SeatIndex): GameState {
  let next = state;
  for (const id of [...listAt(state, zoneKey(seat, 'battlefield'))]) {
    const inst = next.instances[id];
    if (inst === undefined || inst.zone !== 'battlefield') continue;
    if (scriptOf(next, id)?.saga !== true) continue;
    next = addLore(next, id, 1);
  }
  return next;
}

/** What happens as a step begins, before anyone gets priority. */
/**
 * A time counter off each of this seat's suspended cards, and the cast the last one raises
 * (CR 702.62b, CR 702.62c).
 *
 * Two things worth saying about the shape. The **counter going to nothing is what "suspended" stops
 * meaning**: `addCounters` deletes a counter that reaches zero, so a card whose cast is declined or
 * impossible is left in exile with no time counters and is never offered again — which is the rule
 * ("it remains exiled") and costs no extra state to say.
 *
 * And **one card at a time**: an offer stops the table, so a seat with two cards finishing together
 * is asked about the first and the second keeps its zero until the next pass through here, which is
 * the next upkeep. Rare enough that the simple version is the right one, and the alternative — a
 * queue of pending casts — is a second mechanism for a case this pool cannot build.
 */
function tickSuspended(state: GameState, seat: SeatIndex): GameState {
  let next = state;
  let finished: string | undefined;
  for (const id of [...listAt(next, zoneKey(seat, 'exile'))]) {
    const inst = next.instances[id];
    if (inst === undefined || (inst.counters[TIME] ?? 0) <= 0) continue;
    next = addCounters(next, id, TIME, -1);
    if ((next.instances[id]?.counters[TIME] ?? 0) === 0) {
      // Recorded for the log, because the cast that follows moves the card out of exile and takes
      // the evidence with it — see `GameState.expired`. Every card that finishes is recorded, not
      // only the one that gets to be cast now: the clock ran out either way.
      next = recordExpiry(next, id, TIME);
      if (finished === undefined) finished = id;
    }
  }
  if (finished === undefined || next.pendingOfferedCast !== null) return next;
  return suspendedCast(next, finished);
}

function onEnterStep(state: GameState, step: Step): GameState {
  let next = state;
  switch (step) {
    case 'untap':
      next = untapAll(next, next.activeSeat);
      next = {
        ...next,
        landsPlayed: { ...next.landsPlayed, [String(next.activeSeat)]: 0 },
        // And any extra land drops this seat was given, which last for the turn they were given
        // in (CR 505.5b): a permission that outlived its turn would be a different card.
        extraLands: { ...next.extraLands, [String(next.activeSeat)]: 0 },
      };
      // "Until your next turn" ends here, before anybody can read the board it was changing —
      // which is the whole reason that duration exists. See `EffectDuration`.
      next = {
        ...next,
        effects: expireEffects(next, 'until-controllers-next-turn', next.activeSeat),
      };
      return next;

    case 'upkeep':
      /*
        A time counter off each of the active player's suspended cards (CR 702.62b), before the
        upkeep's own triggers go on the stack.

        A **turn-based action** like the Saga's lore counter below, and for the same reason: it
        happens as the step begins, nobody has priority, and nothing can be done about the counter
        itself. What *can* be answered is the cast the last counter off raises — which is why the
        tick and the cast are two different things, and why the cast goes through the offer family
        rather than happening here.
      */
      return tickSuspended(next, next.activeSeat);

    /*
      A lore counter on each of the active player's Sagas (CR 714.2a).

      Here rather than as a trigger, because it is a **turn-based action**: it happens as the phase
      begins, before anybody has priority, and nothing can be done in response to the counter going
      on. What *can* be answered is the chapter ability it puts on the stack, which is why the
      counter and the ability are two different things.
    */
    case 'precombat-main':
      return advanceSagas(next, next.activeSeat);

    case 'draw':
      // The player who goes first skips their first draw (CR 103.8a).
      if (next.turn === 1) return next;
      /*
        Owed rather than taken, because this is the draw dredge is about (CR 702.52a).

        `drawLater` defers it to the top of the `settle` that every caller of `advanceStep` runs
        next, where it is either replaced by a dredge or simply drawn — see `drainOwedDraws`. The
        step is a priority step, so the table stops here either way and nothing is skipped past.
      */
      return drawLater(next, next.activeSeat, 1);

    case 'declare-blockers': {
      // A defender with nothing that could legally block has no decision to make, so it is made
      // for them; otherwise the game would stop and wait for an answer with one option.
      const declared = [...next.combat.blockersDeclaredBy];
      for (const seat of new Set(next.combat.attacks.map((a) => a.defender))) {
        if (!declared.includes(seat) && legalBlockers(next, seat).length === 0) declared.push(seat);
      }
      // And when that settled every declaration, the attacks that got through say so from here:
      // nobody is going to send an `auto:block` for a seat that was never asked. See
      // `raiseUnblockedAttacks`.
      return raiseUnblockedAttacks({
        ...next, combat: { ...next.combat, blockersDeclaredBy: declared },
      });
    }

    case 'first-strike-damage':
      if (!needsFirstStrikeStep(next, next.combat)) return next;
      next = dealCombatDamage(next, true);
      return { ...next, combat: { ...next.combat, firstStrikeDealt: true } };

    case 'combat-damage':
      if (next.combat.attacks.length === 0) return next;
      return dealCombatDamage(next, false);

    case 'end-combat':
      /*
        Myriad's tokens go, and they go **before** the combat is cleared (CR 702.111a).

        Order matters for one reason: exiling a permanent that is still an attacker leaves the
        attack behind it, and `relocate` is what notices. Clearing combat first would strand the
        tokens' attacks in a combat nobody owns for the instant between the two statements — which
        nothing would read, but a reader of this function would have to prove that.

        Every marked permanent rather than a list kept somewhere, which is the point of marking
        them: a token whose granting Equipment was answered mid-combat still goes, a token stolen by
        a Mind Control still goes, and a game state loaded out of Redis still knows which bodies
        were borrowed. See `MYRIAD`.
      */
      for (const seat of next.seats) {
        for (const id of [...listAt(next, zoneKey(seat.index, 'battlefield'))]) {
          if ((next.instances[id]?.counters[MYRIAD] ?? 0) > 0) next = exileCard(next, id);
        }
      }
      // "Until end of combat" is a duration the engine declared and nothing expired, which meant
      // an effect using it would have lasted the rest of the game. The step the name points at is
      // the only place it could ever have been dropped.
      return { ...next, combat: EMPTY_COMBAT, effects: expireEffects(next, 'end-of-combat') };

    case 'end': {
      /*
        The monarch draws a card at the beginning of their own end step (CR 720.4).

        A turn-based action here rather than a triggered ability on the stack, which is a
        simplification worth being explicit about: the real rule is a triggered ability the monarch
        controls, so at a real table it could be countered by a Disallow. Nothing in this engine can
        put an ability on the stack without a card to own it, so the draw happens and the log says
        so. The same shortcut, for the same reason, is taken by the crown changing hands below.

        Before the step trigger, because that is the order a player sees it: the card is drawn as
        the step begins, and anything that triggers on the end step goes on the stack after.
      */
      if (next.monarch !== null && next.monarch === next.activeSeat
        && next.seats[next.monarch]?.eliminated === false) {
        next = draw(next, next.monarch, 1);
      }
      return next;
    }

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
  /*
    And the turn's own tally of spells, which is what "this turn" means for storm (CR 702.40a).

    Here rather than at the start of the next turn, with the damage and the until-end-of-turn
    effects, because this is the step that ends the turn: a spell cast in somebody's end step was
    cast *this* turn, and a counter reset on the untap would still be carrying it.
  */
  return {
    ...next, effects: expireEffects(next, 'end-of-turn'), pendingDiscard: null,
    spellsCastThisTurn: 0,
    // And the per-seat half of the same tally, which is what "your second spell each turn" counts.
    spellsCastThisTurnBy: {},
    // And the turn's life loss, cleared here for the same reason: life lost in somebody's end step
    // was lost *this* turn, so a spectacle cost is payable until the turn is actually over.
    lifeLostThisTurn: {},
    // And the turn's draws, the third of the three. A card drawn in somebody's end step was drawn
    // this turn, so the next card drawn after the cleanup is the first of a new turn — which is
    // what makes it a miracle.
    cardsDrawnThisTurn: {},
    detached: {},
  };
}

// ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

function triggerMatches(
  event: TriggerEvent, want: TriggerEvent, sourceSeat: SeatIndex, actorSeat: SeatIndex | undefined,
  isSubject = true, isAttachedSubject = false,
): boolean {
  if (event.kind !== want.kind) return false;
  switch (want.kind) {
    case 'spell-cast': {
      const e = event as Extract<TriggerEvent, { kind: 'spell-cast' }>;
      /*
        "When you cast this spell": the card's own cast and nobody else's (CR 702.85a).

        Asked first and answered on its own terms, because every other clause below is about a
        spell somebody *else* might have cast. `isSubject` is the whole question — `raise` offers
        this event to the card on the stack as its own subject — and a watcher that is not the
        spell is simply not what this trigger is about, however the rest of it reads.
      */
      if (want.self === true) return isSubject;
      /*
        A cast or a copy, and the default is `cast` so that every watcher older than this clause
        keeps seeing exactly what it saw before. A copy of a spell is not cast (CR 707.12), so
        storm, cascade, prowess and a Chalice of the Void must all miss it — and magecraft, which
        is printed "cast **or copy**", is the one thing in the pool that asks for both.
      */
      const how = want.how ?? 'cast';
      if (how !== 'any' && (e.how ?? 'cast') !== how) return false;
      /*
        "Your **second** spell each turn", answered from the event's own ordinal — the same shape
        the draw family above takes, and for the same reason: by the time the trigger resolves the
        tally has moved on. Counted per caster, so at a four-seat table it is your second spell and
        not the table's. See `GameState.spellsCastThisTurnBy`.
      */
      if (want.onNth !== undefined && e.nth !== want.onNth) return false;
      const by = want.by ?? 'you';
      if (by === 'you' && actorSeat !== sourceSeat) return false;
      if (by === 'opponent' && actorSeat === sourceSeat) return false;
      /*
        The card type the spell has to have, asked **before** the creature/noncreature split and
        separately from it: an artifact creature spell is both, so "whenever you cast an artifact
        spell" and "whenever you cast a creature spell" are two filters rather than two values of
        one. `types` is lowercased where the engine raises it, so the question is too.
      */
      if (want.ofType !== undefined && !(e.types ?? []).includes(want.ofType)) return false;
      /*
        The colour, the subtypes and the mana value, all answered from the event rather than from
        the board (D474). The object may already have left the stack by the time this is asked, and
        an {X} spell's mana value counts the X it was cast for (CR 202.3b) — neither of which a
        reader looking at a card definition could recover.

        `ofColours` is any-of, so a white-and-blue spell passes "a white spell" and a Mold Adder's
        "a blue or black spell" fires on either — which is what CR 105.2 says a colour is and what
        the printed "or" says it means. `multicoloured` is CR 105.1's two-or-more, asked of the same
        list, and `ofSubtypes` is the back half of the type line, matched case-insensitively because
        the printed line capitalises a subtype and nothing lowercases it on the way past.
      */
      if (want.ofColours !== undefined
        && !want.ofColours.some((colour) => (e.colors ?? []).includes(colour))) return false;
      if (want.multicoloured === true && (e.colors ?? []).length < 2) return false;
      if (want.ofSubtypes !== undefined && !want.ofSubtypes.some((sub) => (
        (e.subtypes ?? []).some((printed) => printed.toLowerCase() === sub.toLowerCase())
      ))) return false;
      if (want.manaValueAtLeast !== undefined && (e.manaValue ?? 0) < want.manaValueAtLeast) {
        return false;
      }
      if (want.manaValueAtMost !== undefined && (e.manaValue ?? 0) > want.manaValueAtMost) {
        return false;
      }
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
    /*
      "Whenever you attack" — the declaration, which is one event however many creatures were in it.
      `raise` offers it to every permanent on the battlefield, so whose declaration it was is the
      whole of the filter: there is no subject to be, and no size or type to ask about (see the
      event's own declaration for why those stay unread).
    */
    case 'attack-declared': {
      const by = want.by ?? 'you';
      if (by === 'you') return actorSeat === sourceSeat;
      if (by === 'opponent') return actorSeat !== sourceSeat;
      return true;
    }
    /*
      And the batched hit, filtered the same way and for the same reason: `raise` offers it to the
      whole battlefield, and whose creatures dealt it is the whole of the question. Which player was
      hit travels on the event rather than being filtered here — no card asks "to *you*", and the
      ones that ask about the player say "that player", which is an answer rather than a filter.
    */
    case 'combat-damage-dealt': {
      const by = want.by ?? 'you';
      if (by === 'you') return actorSeat === sourceSeat;
      if (by === 'opponent') return actorSeat !== sourceSeat;
      return true;
    }
    /*
      A draw, with the same three-way `by` a cast has.

      `you` by default rather than `any`, so a card that says nothing watches its own controller —
      the same default every other event here takes, and the one that is right for the card that
      grows when *you* draw. `opponent` is the one Underworld Dreams needs and the one a default of
      `any` would have made unwritable: "whenever an opponent draws a card" is not "whenever a card
      is drawn" at a four-seat table.
    */
    case 'draws': {
      const e = event as Extract<TriggerEvent, { kind: 'draws' }>;
      /*
        "Your **second** card each turn", answered from the event's own ordinal. Asked before `by`
        because it is the cheaper question and because it is the one that is new; the order makes no
        difference to the answer.
      */
      if (want.onNth !== undefined && e.nth !== want.onNth) return false;
      const by = want.by ?? 'you';
      if (by === 'you') return actorSeat === sourceSeat;
      if (by === 'opponent') return actorSeat !== sourceSeat;
      return true;
    }
    /*
      "Whenever **another** card is put into a graveyard from anywhere" — or this one.

      `another` is the default and the self-exclusion is not a formality: a Planar Void that is
      destroyed would otherwise exile itself on the way down, which is the one reading of the card
      the printed word "another" exists to rule out. `self` is the other card shape — Rancor's
      "when this is put into a graveyard from anywhere" — and it needs the watcher loop in `raise`
      to ask a card that is already in the graveyard, the way it does for a death. Nothing else is
      asked: the event carries no `by` and no `what`, for the reason its declaration gives.
    */
    case 'to-graveyard': {
      const who = want.who ?? 'another';
      if (who === 'self') return isSubject;
      if (who === 'another') return !isSubject;
      return true;
    }
    /*
      "Whenever a creature you control is exiled" — and the two narrower questions inside it.

      There is no `who` here and the omission is the rule rather than an oversight: a card cannot
      watch its own exile, because the watcher loop below requires a watcher to be on the
      battlefield and a card in exile is not. `dies`, `leaves` and `to-graveyard` each carve out an
      exception for their own subject, and each was carved for a printed card — Rancor fires from
      the graveyard it has just reached. Nothing is printed that fires from exile, and a Soulherder
      exiled by its own blink would put a counter on an object that no longer exists either way
      (CR 400.7), so the two readings agree.

      What is asked is the three things the event carries, each for one word of that phrase: the
      zone it came from, so an escape cost paid out of a graveyard is not a creature you control
      leaving the battlefield; whether it was a creature at the time; and whose it was.
    */
    case 'to-exile': {
      const e = event as Extract<TriggerEvent, { kind: 'to-exile' }>;
      if ((want.from ?? 'anywhere') === 'battlefield' && e.cameFrom !== 'battlefield') return false;
      if ((want.what ?? 'any') === 'creature' && e.subjectIsCreature !== true) return false;
      const whose = want.whose ?? 'any';
      if (whose === 'any') return true;
      if (e.subjectSeat === undefined) return false;
      return whose === 'you' ? e.subjectSeat === sourceSeat : e.subjectSeat !== sourceSeat;
    }
    case 'step': {
      const e = event as Extract<TriggerEvent, { kind: 'step' }>;
      if (e.step !== want.step) return false;
      return (want.of ?? 'you') === 'any' || actorSeat === sourceSeat;
    }
    /*
      The events that are about one permanent and may still be watched by another. One branch
      rather than six, because `who` and `of` have to mean the same thing on all of them — a
      second copy of this filter is a second place for them to drift apart.

      `combat-damage` had its own arm, two values of `who` and no `of` at all, and that is exactly
      the drift this branch exists to prevent: "whenever a creature you control deals combat damage
      to a player" is the same sentence as "whenever a creature you control dies" with a different
      verb, and it could not be written (D439). Folding it in is behaviour-preserving for everything
      already here, because `who` defaults to `'self'` and that still requires `isSubject`, and `of`
      defaults to `'any'`, which returns before the seat is ever read.
    */
    case 'etb':
    case 'dies':
    case 'attacks':
    case 'blocks':
    case 'becomes-blocked':
    // And their batched halves (D482), which take the same `who` and `of` and carry no other
    // creature at all — see their docblocks in `scriptTypes`.
    case 'blocked-creature':
    case 'blocking-creature':
    case 'attacks-unblocked':
    case 'combat-damage': {
      // `self` is the default, which is why every script written before this one still means what
      // it meant: a trigger that says nothing about `who` watches only its own permanent.
      const who = want.who ?? 'self';
      if (who === 'self' && !isSubject) return false;
      if (who === 'another' && isSubject) return false;
      /*
        `attached` is an Aura's or an Equipment's own creature, and it is a guard rather than an
        early `return true` on purpose: everything below — `what`, `nontoken`, `alone`,
        `withAtLeast`, `of` — still has to be asked. "Whenever equipped creature attacks alone" is
        a printed line, and a branch that returned early here would read it as the bare attack.
      */
      if (who === 'attached' && !isAttachedSubject) return false;
      const e = event as {
        subjectSeat?: SeatIndex; subjectIsCreature?: boolean; subjectIsToken?: boolean;
        subjectIsLand?: boolean; subjectTypes?: readonly string[];
        subjectPower?: number; subjectToughness?: number;
        subjectKeywords?: readonly string[]; subjectSubtypes?: readonly string[];
        subjectCounters?: Readonly<Record<string, number>>;
        alone?: boolean; declared?: number;
      };
      if (want.kind === 'dies' && want.nontoken === true && e.subjectIsToken === true) return false;
      // "attacks **alone**" — exalted's clause, and a fact about the declaration rather than about
      // the creature, which is why the event has to carry it (CR 702.90b).
      if (want.kind === 'attacks' && want.alone === true && e.alone !== true) return false;
      // And battalion's: at least N creatures in the declaration, counted where it happened.
      if (want.kind === 'attacks' && want.withAtLeast !== undefined
        && (e.declared ?? 0) < want.withAtLeast) return false;
      // "a *creature* you control enters" is what the board-watchers say, and an enchantment
      // arriving is not that. Only asked for when the trigger asks for it, so a `self` trigger on
      // a non-creature permanent still fires for its own arrival. Anything in combat is a creature
      // by definition, which is why none of the three combat events has a `what` to ask about.
      if ((want.kind === 'etb' || want.kind === 'dies') && (want.what ?? 'permanent') === 'creature'
        && e.subjectIsCreature !== true) return false;
      // And the landfall half of the same question, asked the same way round: only when the
      // trigger asks for it, so nothing written before this changes meaning.
      if (want.kind === 'etb' && want.what === 'land' && e.subjectIsLand !== true) return false;
      /*
        And the two the board prints as often as "creature" (D477): "whenever an **artifact** you
        control enters", constellation's and eerie's "an **enchantment** you control enters".

        Answered from the subject's live type line rather than from a boolean of its own, because
        unlike creature and land there is nothing in the characteristics layer that these two mean
        beyond being on the type line. `subjectTypes` says why the other two keep their booleans.
      */
      if ((want.kind === 'etb' || want.kind === 'dies')
        && (want.what === 'artifact' || want.what === 'enchantment')
        && !(e.subjectTypes ?? []).includes(want.what)) return false;
      /*
        The characteristic filters (D478), each asked of what the event carries rather than of the
        board: by the time a death trigger resolves the permanent is in a graveyard with no
        counters and no keywords (CR 603.6e), and by the time an entry trigger resolves another
        effect may already have changed it.

        A missing fact fails the filter rather than passing it. An event raised without a power —
        anything that is not a creature — cannot be "a creature with power 3 or greater", so the
        `?? -Infinity` reading would be wrong in the lenient direction; `undefined` is refused.
      */
      if (want.kind === 'etb' || want.kind === 'dies') {
        if (want.powerAtLeast !== undefined
          && !(e.subjectPower !== undefined && e.subjectPower >= want.powerAtLeast)) return false;
        if (want.powerAtMost !== undefined
          && !(e.subjectPower !== undefined && e.subjectPower <= want.powerAtMost)) return false;
        if (want.toughnessAtLeast !== undefined
          && !(e.subjectToughness !== undefined
            && e.subjectToughness >= want.toughnessAtLeast)) return false;
        if (want.toughnessAtMost !== undefined
          && !(e.subjectToughness !== undefined
            && e.subjectToughness <= want.toughnessAtMost)) return false;
        if (want.withCounter !== undefined
          && (e.subjectCounters?.[want.withCounter] ?? 0) < 1) return false;
        if (want.withKeyword !== undefined
          && !(e.subjectKeywords ?? []).includes(want.withKeyword)) return false;
        /*
          And the tribe (D479), matched case-insensitively against the subject's live subtypes —
          the same comparison the cast event's `ofSubtypes` makes, because the printed line
          capitalises a subtype and nothing lowercases it on the way past.
        */
        if (want.ofSubtypes !== undefined && !want.ofSubtypes.some((sub) => (
          (e.subjectSubtypes ?? []).some((printed) => printed.toLowerCase() === sub.toLowerCase())
        ))) return false;
      }
      const of = want.of ?? 'any';
      if (of === 'any') return true;
      if (e.subjectSeat === undefined) return false;
      return of === 'you' ? e.subjectSeat === sourceSeat : e.subjectSeat !== sourceSeat;
    }
    /*
      Ward's event, and the one filter it needs: whose spell or ability did the targeting.

      `raise` has already narrowed the watchers to the permanent that was targeted, so there is no
      `who` to ask about — but there is very much a `by`, and it defaults to `opponent` rather than
      to `you`. Without that default a Ward {2} would counter its own controller's Giant Growth,
      which is the one thing ward never does.
    */
    case 'targeted': {
      const by = want.by ?? 'opponent';
      if (by === 'any') return true;
      if (actorSeat === undefined) return false;
      return by === 'you' ? actorSeat === sourceSeat : actorSeat !== sourceSeat;
    }
    /*
      A Saga's chapter, which is about one permanent and one number.

      `raise` has already narrowed the watchers to the Saga the counter went on, so all that is
      left is whether this is the chapter that number means. A Saga with chapters I, II and III
      sees all three events over three turns and each ability answers to exactly one.
    */
    case 'chapter': {
      const e = event as Extract<TriggerEvent, { kind: 'chapter' }>;
      return isSubject && e.n === want.n;
    }
    case 'becomes-tapped':
    case 'leaves':
    // Narrowed to its own permanent by `raise`, like the two above: a morph turning over is its
    // own business, and the one thing worth checking is already checked by being in that list.
    case 'turned-face-up':
    // And a transform, for exactly the same reason.
    case 'transformed':
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

/**
 * Which object on the stack an event was about, for the two events that are about one.
 *
 * A ward's `targeted` is the spell that took aim at its creature; a `spell-cast` is the spell that
 * was just cast. Everything else here is about a permanent or a player, and gets nothing. It is a
 * function rather than a line inside `raise` because both of that function's readers need it — the
 * intervening-if clause is asked before the ability is built, and it has to be asked the same
 * question the resolution will ask it later.
 */
function answeringFor(event: TriggerEvent): string | undefined {
  if (event.kind === 'targeted' || event.kind === 'spell-cast') return event.object;
  return undefined;
}

/**
 * One trigger, asked whether this event fired it, and put on the stack if it did.
 *
 * Pulled out of `raise`'s watcher loop because there are now **two** places a permanent's
 * triggered abilities come from: the ones printed on its own card, and the ones another permanent
 * is handing it (`ContinuousEffect.grants`). Everything after "does this match" is identical for
 * the two — the intervening-if clause asked its first time, the five fields saying what the event
 * was about, the targets that are obvious and the prompt when they are not — and the version of
 * this engine where that was duplicated for the granted case would have been two copies drifting
 * apart, which is the bug `modsFrom`'s docblock is about.
 *
 * `holder` is the permanent whose ability this is, which for a granted trigger is **not** the card
 * that defines it: the ability belongs to the creature it was given to (CR 113.6), so the
 * condition, the targets and the resolution all read the holder as their source, and the
 * controller is the holder's controller. `grantedBy` is the only thing that travels differently,
 * and it travels to the stack object so the resolution can find the definition again.
 *
 * Returns the state unchanged when the trigger did not fire, which is most calls.
 */
function fireTrigger(
  state: GameState, trigger: TriggerDef, holder: string, inst: CardInstance,
  abilityIndex: number, event: TriggerEvent, actor: SeatIndex | undefined,
  subject: string | undefined, fromStack: boolean, grantedBy?: GrantedTriggerRef,
): GameState {
  let next = state;
  // A delayed trigger is scheduled, not watched for: the step it names drains it exactly once
  // and the ordinary event path must never fire it (CR 603.7). See `TriggerDef.delayed`.
  if (trigger.delayed === true) return next;
  /*
    A spell on the stack watches its own cast and nothing else.

    Without this a card being cast would fire every battlefield trigger printed on it on the
    way past: a Guttersnipe cast as a creature spell is not a Guttersnipe in play, and a
    prowess creature does not get +1/+1 for being cast. `self` is what tells the two apart,
    and it is asked here rather than in `triggerMatches` because this is a fact about where the
    watcher *is* rather than about what the event was.
  */
  if (fromStack && !(trigger.on.kind === 'spell-cast' && trigger.on.self === true)) return next;
  /*
    Heroic: "whenever you cast a spell **that targets this creature**" (CR 702.86a, D476).

    Here rather than in `triggerMatches` for the reason `self` above is: it is a question about
    which permanent is watching, and `triggerMatches` is not told the holder. The targets are on
    the event — `targetIds`, card targets only — because by the time this ability resolves the
    spell may have been countered or have resolved off the stack.

    `targetIds` is absent on an event the engine raised before this field existed; an absent list
    means "no card targets", which is the reading that refuses rather than the one that fires.
  */
  if (trigger.on.kind === 'spell-cast' && trigger.on.targetsSelf === true
    && !(event.kind === 'spell-cast' && (event.targetIds ?? []).includes(holder))) return next;
  /*
    The attachment, resolved here rather than in `triggerMatches` for the same reason `self` is:
    it is a fact about where the watcher *is*, not about what the event was.

    Read through `next.instances[holder]` rather than off the captured `inst`, and the difference
    is **not** the one a first reading suggests: both call sites below pass the holder's own
    instance, including the granted-ability one (CR 113.6 moves the ability, not the lookup), so
    `inst.attachedTo` names the same permanent. What the lookup buys is freshness — `inst` was
    captured before this permanent's earlier triggers were offered the event, and `next` is current.
    Nothing in that loop resolves anything, so no card can tell the two apart today; a break run
    confirmed it, failing no test when switched to `inst`. It stays as the reading that is right by
    construction rather than by an argument about what the loop does not do.

    `attachedTo` lives on the Aura or Equipment and points at its host, so this is one lookup and
    no search.
  */
  const attachedHost = next.instances[holder]?.attachedTo ?? null;
  /*
    Was this watcher attached to what the event is about? Two sources, and the event wins when it
    has an answer.

    For an attack or a hit the attachment is still on the board, so the live reading is the right
    one. For a **death** it is not: `relocate` detaches everything pointing at a card as it leaves,
    which it has to (a dead creature's `+2/+0` would otherwise sit in `effects` for ever), so by
    here the Equipment is attached to nothing rather than to something dead. The `dies` event
    carries the list it had instead — see `GameState.detached` — and `??` is what makes the two
    readings one rule: the event's answer when there is one, the board's when there is not.

    D433 deferred `who: 'attached'` on `dies` over exactly this and guessed it was an ordering
    question. It was a defect, and a probe is what settled it: a Lead Pipe on a creature killed by a
    Bolt fired nothing, with `attachedTo` already null.
  */
  const wasAttached = (event as { attachments?: readonly string[] }).attachments?.includes(holder);
  if (!triggerMatches(
    event, trigger.on, inst.zoneSeat, actor, holder === subject,
    wasAttached ?? (attachedHost !== null && attachedHost === subject),
  )) return next;
  /*
    The intervening-if clause, asked the first of its two times (CR 603.4).

    Before the ability goes on the stack, not after: a trigger whose condition is false does
    not trigger at all, so nobody gets to respond to it and nothing appears in the log. The
    second ask is in `resolveTop`, where a condition that has since become false removes the
    ability from the stack.
  */
  if (trigger.condition !== undefined && !trigger.condition({
    state: next,
    source: holder,
    controller: inst.zoneSeat,
    targets: [],
    x: 0,
    decisions: [],
    kicked: false,
    ...(subject === undefined ? {} : { subject }),
    /*
      And the object the event was about, which the *second* ask (in `resolveTop`) has always
      had and this one did not.

      A condition that reads the spell on the stack is the whole of what Chalice of the Void
      is: "whenever a player casts a spell with mana value equal to the number of charge
      counters on this". Without it here, the first ask would answer a different question from
      the second — the ability would go on the stack for every spell anybody cast and then
      vanish on resolution — which is observably the wrong card: an opponent would see a
      trigger they could respond to for a spell that was never going to be countered.
    */
    ...(answeringFor(event) === undefined ? {} : { answering: answeringFor(event) }),
    /*
      And what the subject had on it, which the second ask has always had for the same reason.

      Undying is the card that needs it: "if it had no +1/+1 counter on it" is an intervening-if
      about a creature that is already in a graveyard with its counters taken off, so the only
      place the answer survives is the snapshot the event carries. Without this line the first
      ask would say yes for a creature that had a counter and the second would say no — the
      ability would go on the stack for an opponent to respond to and then do nothing, which is
      the shape of wrongness this clause exists to prevent.
    */
    ...('subjectCounters' in event && event.subjectCounters !== undefined
      ? { subjectCounters: event.subjectCounters }
      : {}),
  })) return next;
  const specs = trigger.targets ?? [];
  /*
    Which player this event was about, for the two events that are about one.

    An attack trigger says who was attacked; a combat-damage trigger says who was hit. They are
    the same question — "the player this ability's event happened to" — so they travel the same
    way rather than growing a second field for the second card that needs it. See
    `StackObject.attacked`.
  */
  const attacked = event.kind === 'attacks' || event.kind === 'attacks-unblocked'
    ? event.attacked
    : (event.kind === 'combat-damage' || event.kind === 'combat-damage-dealt')
      && event.defender !== undefined
      ? { defender: event.defender }
      : undefined;
  const answering = answeringFor(event);
  // And which permanent it was about, for a trigger that has to say "that creature". Only for
  // the three events that have a subject other than the watcher itself — a card watching its
  // own arrival already knows which permanent it means.
  const about: TriggerAbout = {
    // Whoever did the thing, for "that player". Only when it is somebody other than the
    // watcher: a card that means its own controller says `controller` and always could.
    ...(actor === undefined || actor === inst.zoneSeat ? {} : { actor }),
    ...(attacked === undefined ? {} : { attacked }),
    ...(answering === undefined ? {} : { answering }),
    ...(subject === undefined
      || !(event.kind === 'etb' || event.kind === 'dies' || event.kind === 'attacks'
        || event.kind === 'blocks' || event.kind === 'becomes-blocked'
        || event.kind === 'blocked-creature' || event.kind === 'blocking-creature'
        || event.kind === 'attacks-unblocked' || event.kind === 'to-graveyard'
        // And the creature that dealt the damage, for "put a +1/+1 counter on **that creature**".
        // Added with `who: 'any'` (D439): while the event was its own permanent's business the
        // subject was always the watcher, so a card had no "that creature" to mean.
        || event.kind === 'combat-damage')
      ? {}
      : { subject }),
    // The attacker a block was against, for "that creature". Its own field rather than the
    // subject, because the subject of a block is the creature that blocked — which is almost
    // always the watcher itself, and never the one the card is talking about.
    ...((event.kind === 'blocks' || event.kind === 'becomes-blocked')
      && event.blocked !== undefined
      ? { blocked: event.blocked }
      : {}),
    // What it had on it before the event, for a trigger that counts counters that are gone by
    // the time it resolves. See `StackObject.subjectCounters`.
    ...(event.kind === 'dies' && event.subjectCounters !== undefined
      ? { subjectCounters: event.subjectCounters }
      : {}),
  };
  if (specs.length === 0) {
    return pushAbility(
      next, holder, inst.zoneSeat, abilityIndex, [], 'triggered', trigger.description, about,
      grantedBy,
    );
  }
  // A trigger that needs targets and has none legal is never put on the stack (CR 603.3c).
  if (!hasAnyLegalTargets(next, specs, inst.zoneSeat, holder)) return next;
  const auto = obviousTargets(next, specs, inst.zoneSeat, holder);
  next = pushAbility(
    next, holder, inst.zoneSeat, abilityIndex, auto ?? [], 'triggered', trigger.description, about,
    grantedBy,
  );
  if (auto !== null) {
    // An ability the engine aimed for its controller has its targets now, so anything it took
    // aim at that wards gets to say so. See `raiseTargeted`.
    return raiseTargeted(next, next.stackOrder[next.stackOrder.length - 1]!);
  }
  // Otherwise the controller chooses, and nothing happens until they do.
  const stackId = next.stackOrder[next.stackOrder.length - 1]!;
  return {
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

function raise(
  state: GameState, event: TriggerEvent, actor?: SeatIndex, subject?: string,
): GameState {
  let next = state;
  if (subject !== undefined
    && (event.kind === 'etb' || event.kind === 'dies' || event.kind === 'attacks'
      || event.kind === 'blocks' || event.kind === 'becomes-blocked'
      // The batched pair (D482). Their subject is the creature that became blocked or that
      // blocked, which for the printed lines is the watcher itself — so `c.subject` and `c.source`
      // agree today, and a line that is added for somebody else's creature gets the right one.
      || event.kind === 'blocked-creature' || event.kind === 'blocking-creature'
      || event.kind === 'attacks-unblocked' || event.kind === 'to-graveyard'
      || event.kind === 'to-exile')) {
    // Which permanent the event was about, so a trigger can say "that creature" rather than only
    // "this creature". The seat and the creature-ness below are *whose* and *what kind*; this is
    // which one. See `EffectContext.subject`.
    event = { ...event, subject };
  }
  /*
    Whose card it was, for the two events whose subject is somewhere the block below cannot read.

    Narrower than that block on purpose: a card in a graveyard has no `vanished` snapshot to read
    and nothing in the pool asks whether it was a creature, so the one fact these events carry is
    the seat — which is what "put into *your* graveyard" needs, and what "a creature **you control**
    deals combat damage to a player" needs (D439). The combat case reads the live instance because
    the creature that connected is still on the battlefield, which is also why it cannot share the
    `vanished`-first block below.
  */
  if (subject !== undefined && (event.kind === 'to-graveyard' || event.kind === 'combat-damage')) {
    const inst = next.instances[subject];
    if (inst !== undefined) event = { ...event, subjectSeat: inst.zoneSeat };
  }
  if (subject !== undefined && (event.kind === 'etb' || event.kind === 'dies')) {
    // The event carries who controlled the permanent and whether it was a creature, so a watcher
    // can ask. Read from the subject rather than from `actor`, which for an entry is whoever cast
    // the spell and not always its controller.
    /*
      The snapshot first, and the live instance second.

      A permanent that has just left the battlefield is still in `instances` — in a graveyard, with
      its counters already wiped — so reading it live would answer the question with the state
      *after* the event. `vanished` holds what it was, which is what a leave-the-battlefield
      trigger is entitled to (CR 603.6e). See `GameState.vanished`.
    */
    const inst = next.vanished[subject] ?? next.instances[subject];
    if (inst !== undefined) {
      /*
        One characteristics computation for the three facts below, where there were two for two
        (D477). It is the expensive call in this function — every continuous effect in play is
        folded over a permanent's printed card to make it — and `raise` runs on every entry and
        every death of every game the bot simulates, so a third call for `subjectTypes` would have
        been a third of that cost for a field read by one filter.
      */
      const live = characteristicsOf(next, inst);
      event = {
        ...event,
        subjectSeat: inst.zoneSeat,
        subjectIsCreature: live.isCreature,
        // And whether it was a land, for the landfall templating. Only on an entry: "whenever a
        // land dies" is not a card, and a field nothing reads is a field that drifts.
        ...(event.kind === 'etb' ? { subjectIsLand: live.isLand } : {}),
        /*
          And its live card types, for the artifact and enchantment board-watchers (D477). Read off
          the characteristics' type line, so a permanent whose type was changed by an effect is
          matched on what it *is* rather than on what it was printed as — the same reading the
          target filters have taken since D419.
        */
        ...(event.kind === 'etb' || event.kind === 'dies'
          ? {
            subjectTypes: live.typeLine.types.map((t) => t.toLowerCase()),
            /*
              And its size and its keywords, for the characteristic filters (D478). Off the same
              one computation as everything above, so the four filters cost nothing beyond the
              two numbers and an array this function already had in hand.
            */
            subjectPower: live.power,
            subjectToughness: live.toughness,
            subjectKeywords: [...live.keywords],
            // And its tribes, for the subtype filter (D479) — as printed, since the question
            // lowercases both sides when it compares.
            subjectSubtypes: live.typeLine.subtypes,
          }
          : {}),
        ...(event.kind === 'dies' ? { subjectIsToken: inst.isToken } : {}),
        // What it had on it, for a trigger that has to count its own counters after they are gone.
        ...(Object.keys(inst.counters).length === 0 ? {} : { subjectCounters: inst.counters }),
      };
    }
  }
  /*
    Which permanents could have a trigger for this event.

    `becomes-tapped` and `leaves` are about one object and only that object's own script can care.
    `etb`, `dies` and `attacks` usually are too — but "~ or another creature dies" is one of the
    commonest black cards there is, and "whenever a creature you control attacks" is the same shape
    one step along, so those offer the event to every permanent on the battlefield and
    `triggerMatches` decides from each trigger's own `who` whether it wants it. The subject is
    always included: it may be the watcher, and for a death it is in a graveyard by now rather
    than on the battlefield.

    **`combat-damage` was in the self-only list and that was a defect (D433).** An Equipment is not
    the creature that deals the damage, so "whenever equipped creature deals combat damage to a
    player" was offered to the creature and never to the Equipment printing it: the trigger existed,
    `triggerMatches` had an arm for it, and nothing could ever reach that arm. The compiler reads
    that prologue on 45 corpus cards, so 45 cards would have compiled with `unread: []` — reported
    fully automated — and done nothing at all, which is the exact failure D362's badge cannot warn
    anybody about. A break run is what surfaced it: setting the matcher's arm back to `isSubject`
    failed no test, because no test could get an event to it.

    Widening it is safe for everything already here because the matcher's default does the
    narrowing instead: `who` defaults to `'self'` and that arm requires `isSubject`, so a Thieving
    Magpie still draws only for its own damage. The cost is the same per-event walk `etb` and
    `attacks` already pay.

    **Taking the name out of this set is the whole fix, and it has to be the only one.** The
    condition below names the board-watching events explicitly *and* falls through to
    `everyBattlefield` for anything it does not name, so that list is redundant for every kind in
    it — which means naming `combat-damage` there as well would have made two independent
    statements of the same thing, and no single break could fail a test. It was written that way
    first and the break run is what caught it: re-adding the name here passed, and so did removing
    it from the condition. One lever, so one break can move it.
  */
  const selfOnly = new Set([
    'becomes-tapped', 'leaves', 'targeted', 'turned-face-up', 'transformed',
    'chapter',
  ]);
  const everyBattlefield = apnapSeats(next).flatMap((seat) => {
    const mine = [...listAt(next, zoneKey(seat, 'battlefield'))].filter((id) => id !== subject);
    // The subject goes with its own controller rather than ahead of everybody: it may be the only
    // watcher, and after a death it is in a graveyard rather than on a battlefield, so it would
    // otherwise be missed. Put first within that seat, which is where it was.
    // With the `vanished` fallback: a token that has ceased to exist is still the subject of its
    // own death, and without this it is not in anybody's watcher list to be asked.
    const subjectSeat = subject === undefined
      ? undefined
      : (next.instances[subject] ?? next.vanished[subject])?.zoneSeat;
    return subjectSeat === seat ? [subject as string, ...mine] : mine;
  });
  /*
    An Aura that was on the dying creature has to be asked even though it is no longer in play.

    `relocate` detaches it and then CR 704.5m puts it into its owner's graveyard, both before the
    death is announced — so a "when enchanted creature dies" Aura is not on anybody's battlefield by
    the time this list is built, and the trigger it exists for would never be offered the event.
    An Equipment stays (CR 301.5c) and is found in `everyBattlefield` the ordinary way; the Aura is
    spliced in from the event's own `attachments`, which is the only place the relationship still
    exists.

    Added with a `Set` rather than appended blindly, because an Equipment on the dying creature is
    in both lists and a trigger offered the same event twice would fire twice.
  */
  const attachedWatchers = event.kind === 'dies'
    ? (event as { attachments?: readonly string[] }).attachments ?? []
    : [];
  const everyBattlefieldAndAttached = attachedWatchers.length === 0
    ? everyBattlefield
    : [...new Set([...everyBattlefield, ...attachedWatchers])];
  const watchers = event.kind === 'etb' || event.kind === 'dies' || event.kind === 'attacks'
    || event.kind === 'blocks' || event.kind === 'becomes-blocked'
    || event.kind === 'blocked-creature' || event.kind === 'blocking-creature'
    || event.kind === 'attacks-unblocked'
    ? everyBattlefieldAndAttached
    : selfOnly.has(event.kind)
      ? subject === undefined ? [] : [subject]
      /*
        A cast is watched from the battlefield **and** by the spell being cast (CR 603.2d).

        The second half is cascade, storm and their family: "when you cast this spell" is an ability
        of a card that is on the stack, not of a permanent, and until this line there was no way for
        a watcher to be anywhere but in play. The subject is the card that was cast, and the loop
        below only offers it to triggers that say `self` — so the Guttersnipes and the prowess
        creatures already in the pool cannot start firing off their own castings.
      */
      : event.kind === 'spell-cast' && subject !== undefined
        ? [subject, ...everyBattlefield.filter((id) => id !== subject)]
        : everyBattlefield;

  for (const id of watchers) {
    /*
      A token that has ceased to exist is still the subject of its own death: its last state is in
      `vanished` for exactly this read (CR 603.6d). Only for the subject — a vanished token is not
      on anybody's battlefield and so is not watching anything else.
    */
    const inst = next.instances[id] ?? (id === subject ? next.vanished[id] : undefined);
    if (inst === undefined) continue;
    // A `dies` trigger fires from the graveyard, but only for the creature that died: any other
    // watcher has to still be on the battlefield to be watching.
    // A `dies` or `leaves` trigger fires from wherever the permanent went, but only for the
    // permanent it happened to: any other watcher has to still be on the battlefield.
    // `to-graveyard` is the third of those and the one where it is the whole card: Rancor's
    // trigger is *about* the graveyard it is now in, so a watcher that has to be on the
    // battlefield could never fire it. Still only for the subject — a card sitting in a graveyard
    // watches nothing else that arrives there.
    /*
      And the fifth: an Aura that was on the dying creature, from the graveyard CR 704.5m has
      already put it in.

      `id === subject` was the whole condition and it is not enough for a death. "When enchanted
      creature dies" is an ability of a card that is **never on the battlefield when the death is
      announced**: the creature's `relocate` detaches the Aura, the state-based action buries it,
      and both happen before `settle` raises anything. So it would be filtered out here even after
      being spliced into the watcher list above, which is exactly what happened — the splice alone
      made no difference and this line is the other half of the same fix.

      An Equipment is on the battlefield throughout (CR 301.5c) and never needed either half; it is
      included because the condition is about where the watcher *is*, and asking which card type
      wrote the trigger would be a worse rule than asking whether the event was about its host.
    */
    const fromGraveyard = (event.kind === 'dies' || event.kind === 'leaves'
      || event.kind === 'to-graveyard')
      && (id === subject || attachedWatchers.includes(id));
    /*
      And the fourth zone a trigger fires from: the stack, for a spell watching its own cast.

      `zone` is checked rather than assumed, because a cast trigger is raised while the card is on
      the stack and nothing else about this loop knows that. See the `self` field on the
      `spell-cast` trigger and the watcher list above.
    */
    const fromStack = event.kind === 'spell-cast' && id === subject && inst.zone === 'stack';
    if (!fromGraveyard && !fromStack && inst.zone !== 'battlefield') continue;
    // From the instance resolved above rather than by id, so a vanished token's own script is
    // still found: `scriptOf` reads `instances`, and a token that ceased to exist is not in it.
    /*
      A face-down permanent has no abilities, so it watches nothing (CR 707.2) — and neither does
      one whose abilities have been taken away (CR 613.1f, layer 6).

      The second clause is newer than the rest and was a real gap: a Frogged Blood Artist went on
      draining when something died, because this loop asked only about the face. It is `undefined`
      rather than a `continue`, so the permanent is still asked about the abilities something else
      is *granting* it below — which is the layer-6 ordering, where a grant made after the Frog
      survives it.
    */
    const script = isFaceDownPermanent(inst) || allAbilitiesLost(next, inst)
      ? undefined
      : scriptForCard(next.cardDefs[inst.defKey]);
    /*
      Its printed triggers, and then the ones somebody else is handing it.

      Two loops rather than one list, because the two are found in different places: a printed
      trigger comes off the card's own script, and a granted one off the continuous effects
      currently reaching this permanent (CR 113.6). They are collected in that order on purpose —
      a permanent's own abilities exist before anything grants it another, and the order several
      triggers of one permanent go on the stack in is the controller's to choose anyway (CR 603.3b).
    */
    for (const [i, trigger] of (script?.triggers ?? []).entries()) {
      next = fireTrigger(next, trigger, id, inst, i, event, actor, subject, fromStack);
    }
    /*
      And the granted ones. `grantedTriggersOn` answers "which, in what order, and with layer 6
      applied"; the definition itself is looked up by card name, which is what makes the effect
      carrying this serialisable. A reference to a card this build does not script is skipped
      rather than thrown on, because a decklist can name a card the engine only half knows.
    */
    for (const ref of grantedTriggersOn(next, inst)) {
      /*
        `scriptFor` by **name** and deliberately not `scriptForCard`: a granted ability is recorded
        on the continuous effect as the granting card's *name* plus an index into its
        `grantedTriggers`, and there is no definition in hand to look up. It is also the one field
        the oracle-text compiler never emits — granting another permanent a triggered ability has no
        reader and, per `soulbondShapeFor`, is a refusal rather than a gap — so the hand-written
        registry is the complete answer here rather than a partial one.
      */
      const granted = scriptFor(ref.card)?.grantedTriggers?.[ref.index];
      if (granted === undefined) continue;
      next = fireTrigger(next, granted, id, inst, ref.index, event, actor, subject, fromStack, ref);
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
 *
 * **"Up to one" with nothing to point at is not a decision either**, and that clause is newer than
 * the rest. An optional spec with no legal targets has exactly one legal answer — none — so asking
 * is a prompt with nothing on it but a way out, which is what a Soulherder alone on the battlefield
 * would have put in front of a player at the end of every turn (and a dying modular creature with
 * no other artifact creature before it). The decision is skipped, not the ability: it still goes on
 * the stack with no targets and does as much as it can, which is nothing (CR 608.2).
 */
function obviousTargets(
  state: GameState, specs: readonly TargetSpec[], controller: SeatIndex, source?: string,
): Target[] | null {
  const chosen: Target[] = [];
  for (const spec of specs) {
    const want = Math.max(1, spec.count ?? 1);
    const available = legalTargets(state, spec, controller, source).filter(
      (t) => !chosen.some((c) => targetKey(c) === targetKey(t)),
    );
    if (spec.optional) {
      if (available.length === 0) continue;
      return null;
    }
    if (available.length !== want) return null;
    chosen.push(...available);
  }
  return chosen;
}

/**
 * Raises ward's event for every opposing permanent a stack object just took aim at (CR 115.7).
 *
 * One function for one rule, called from each of the four places an object on the stack *gains*
 * targets: a spell being cast, an activated ability, a triggered ability whose targets were
 * obvious enough for the engine to fill in, and the same one once its controller has chosen them.
 * Four call sites is three more than anybody wants, but the alternative is folding it into
 * `pushAbility`, which is called from inside this module's own trigger loop — and a function that
 * raises triggers while a trigger loop is walking its watcher list is a reentrancy bug waiting for
 * a card to find it.
 *
 * The triggered-ability case is not completeness for its own sake: Flametongue Kavu's arrival
 * deals its damage to a *target* creature, so without it a Ward {1} would stop a Doom Blade and
 * not a Kavu, which is the kind of inconsistency a player reads as a bug rather than a rule.
 *
 * Only permanents are offered the event: a player target has no abilities, and a target in a
 * graveyard is not on the battlefield to ward anything.
 *
 * **It used to skip the controller's own permanents, and that was one caller's rule written into
 * the engine (D461).** Ward never triggers off its own controller's spells — and `triggerMatches`
 * already enforces exactly that, from the trigger's side, through `by` defaulting to `opponent`.
 * The skip here was a second statement of the same rule, and the second statement was the one that
 * could not be narrowed: **8 legal cards print "Whenever ~ becomes the target of a spell or
 * ability"** with nobody named, which fires off either side's spell (Tethered Skirge, Angelic
 * Protector, Task Force). Their trigger says `by: 'any'` and the event was never raised for it, so
 * the card read as automated and did nothing — which D362 ranks below leaving the line unread.
 *
 * So the filter lives in one place now, where the trigger can ask for something else. What the skip
 * also bought was not walking every target of every spell through the watcher machinery; `raise`
 * narrows to the targeted permanent's own abilities, so the cost is one lookup per card target
 * rather than a sweep of the board, and the 2,250-test suite and 100 pods did not move on it.
 */
export function raiseTargeted(state: GameState, objectId: string): GameState {
  const object = state.stackObjects[objectId];
  if (object === undefined) return state;
  let next = state;
  for (const target of object.targets) {
    if (target.kind !== 'card') continue;
    const inst = next.instances[target.id];
    if (inst === undefined || inst.zone !== 'battlefield') continue;
    next = raise(next, { kind: 'targeted', object: objectId }, object.controller, target.id);
  }
  return next;
}

/**
 * What a triggered ability is *about*, beyond its targets.
 *
 * Three facts that were true of the event and are not readable from the board by the time the
 * ability resolves: what the attack was aimed at, which object on the stack it answers, and which
 * permanent it happened to. One parameter rather than three in a row, so that a call site says
 * which is which and adding a fourth does not silently shift the third.
 */
interface TriggerAbout {
  readonly attacked?: AttackedTarget;
  /** The attacker a `blocks` event was against. See `StackObject.blocked`. */
  readonly blocked?: string;
  readonly answering?: string;
  readonly subject?: string;
  readonly actor?: SeatIndex;
  /** The attack this ability's source is about to join. See `StackObject.enteringAttack`. */
  readonly enteringAttack?: { readonly defender: SeatIndex; readonly planeswalker?: string };
  /** The counters the subject had before the event. See `StackObject.subjectCounters`. */
  readonly subjectCounters?: Readonly<Record<string, number>>;
}

/**
 * Which objects the ability's `subject` and `blocked` are, pinned as it goes on the stack.
 *
 * See `StackObject.aboutSeqs`. Only what is findable now is pinned: an id with no instance behind
 * it — a token whose death trigger is being raised after it stopped existing — gets no entry, so
 * `aboutNow` has nothing to check and that path reads exactly as it did before.
 */
function aboutSeqsFor(
  state: GameState, about: TriggerAbout,
): { aboutSeqs?: Readonly<Record<string, number>> } {
  const seqs: Record<string, number> = {};
  for (const id of [about.subject, about.blocked]) {
    if (id === undefined) continue;
    const seq = state.instances[id]?.objectSeq;
    if (seq !== undefined) seqs[id] = seq;
  }
  return Object.keys(seqs).length === 0 ? {} : { aboutSeqs: seqs };
}

/**
 * The ids a resolving ability says "that creature" with, blanked where the object has been
 * replaced (CR 400.7).
 *
 * `StackObject.subject`'s own comment used to claim this rule — "if the permanent has gone, the
 * ability finds nothing and does nothing" — and that is true only of a permanent that went and
 * stayed gone. One blinked in response comes back wearing the same instance id, and every reader
 * found it. Read here rather than in each script for the reason hexproof is read in `targeting.ts`
 * rather than in each script: a script that had to remember would eventually forget.
 *
 * Blanked only when the object is **there and different**. An id that finds nothing already does
 * nothing wherever it is read, and leaving it alone keeps the one path that reads a card the
 * engine no longer has — a token's own death trigger — exactly as it was.
 */
function aboutNow(
  state: GameState, object: StackObject,
): { subject: string | undefined; blocked: string | undefined } {
  const same = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const was = object.aboutSeqs?.[id];
    const now = state.instances[id]?.objectSeq;
    return was === undefined || now === undefined || now === was ? id : undefined;
  };
  return { subject: same(object.subject), blocked: same(object.blocked) };
}

function pushAbility(
  state: GameState, source: string, controller: SeatIndex, abilityIndex: number,
  targets: readonly Target[], kind: 'activated' | 'triggered', description: string,
  about: TriggerAbout = {},
  /**
   * Which card defines this ability, when the permanent it belongs to did not print it.
   *
   * Its own parameter rather than another `TriggerAbout` field, because it is not of that kind:
   * everything in `about` says what the *event* was, and this says where the *ability* came from.
   * See `StackObject.grantedBy`.
   */
  grantedBy?: GrantedTriggerRef,
): GameState {
  const seq = state.autoSeq + 1;
  const id = `ab${seq}`;
  // `vanished` as the fallback, so a token's own death trigger still carries the card it came
  // from: the object on the stack is identified by `cardKey`, and without it the ability would
  // resolve as nothing at all. See `GameState.vanished`.
  const inst = state.instances[source] ?? state.vanished[source];
  const object: StackObject = {
    id, kind, source, controller,
    cardKey: inst?.defKey ?? '',
    abilityIndex, targets: [...targets], description,
    ...(grantedBy === undefined ? {} : { grantedBy }),
    ...(about.attacked === undefined ? {} : { attacked: about.attacked }),
    ...(about.blocked === undefined ? {} : { blocked: about.blocked }),
    ...(about.answering === undefined ? {} : { answering: about.answering }),
    ...(about.subject === undefined ? {} : { subject: about.subject }),
    ...(about.actor === undefined ? {} : { actor: about.actor }),
    ...(about.subjectCounters === undefined ? {} : { subjectCounters: about.subjectCounters }),
    ...(about.enteringAttack === undefined ? {} : { enteringAttack: about.enteringAttack }),
    targetSeqs: targetSeqsFor(state, targets),
    ...aboutSeqsFor(state, about),
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
 *
 * **The whole list, audited against CR 704.5 rather than grown one card at a time** (#270, D288),
 * because two of these were missing and the audit is the only thing that found them. Where a case
 * lives matters as much as whether it is here:
 *
 * | case | where |
 * | --- | --- |
 * | a player at 0 or less life, ten poison, or 21 commander damage | `engine.ts`, in the pass that runs *after* this one — a seat losing is not a board fix |
 * | a player who tried to draw from an empty library (CR 704.5b) | here, off `drewFromEmpty` |
 * | `+1/+1` and `-1/-1` counters cancelling (CR 704.5q) | here, first in the per-permanent pass (D287) |
 * | a Saga with every chapter spent (CR 714.4) | here |
 * | an Aura attached to nothing, to something gone, or to a host it may not enchant (CR 704.5m) | here, against the Aura's own `enchant` spec — see `isLegalAttachment` |
 * | an Equipment attached to an illegal permanent (CR 301.5c) | unattached rather than binned, which is the difference between the two |
 * | a planeswalker with no loyalty (CR 704.5i) | here |
 * | a creature with 0 toughness or lethal damage (CR 704.5a/g) | here, with regeneration and indestructible |
 * | the legend rule (CR 704.5j) | here, below the deaths (D288) |
 * | a token outside the battlefield ceasing to exist | `cardActions.ts`, in `relocate`, because it is a fact about the move |
 * | a copy of a spell outside the stack ceasing to exist (CR 704.5e) | nowhere, and it cannot be otherwise — see below |
 * | a creature attached to something becoming unattached (CR 704.5p) | in the Aura branch above: the pool's only attached creature is a bestowed one |
 * | a soulbond pair that is no longer two creatures (CR 702.95b) | here, last in the pass |
 *
 * **Nowhere, because the shape of the state already says it.** CR 704.5e is the one case with no
 * check anywhere, and adding one would be writing a branch that cannot be reached: a copy of a
 * spell is a stack object with no instance under its id (see `StackObject.copyOf`), so there is no
 * card to put in a graveyard and no code path that could try. `counterSpell` looks the instance up
 * by the *stack object's* id and finds nothing, so countering a copy removes it and stops — which
 * is the rule, arrived at by construction rather than by enforcement. The test that pins it is the
 * `instances[copy]` assertion in `scripts.test.ts`, not a graveyard count: a count of the cards
 * left behind reads the same whether the rule holds or not, which was worth finding out by
 * breaking `counterSpell` on purpose and watching the count pass anyway.
 *
 * **Not here, and deliberately:** the world rule, which needs a world enchantment and the pool has
 * none, and everything about Battles and Sieges, which this engine has no cards for. Both would be
 * dead code checked every pass.
 */
export function stateBasedActions(state: GameState): GameState {
  if (!state.automated) return state;
  let next = state;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;

    for (const seat of next.seats) {
      if (seat.eliminated) continue;
      // Said as what it is: an empty library, not zero life (CR 704.5b). It used to say `life`,
      // which put "out (life)" on a table beside a nineteen.
      if (next.drewFromEmpty.includes(seat.index)) {
        next = replaceSeat(next, seat.index, { eliminated: true, eliminatedReason: 'library' });
        changed = true;
      }
    }

    for (const seatRecord of next.seats) {
      for (const id of [...listAt(next, zoneKey(seatRecord.index, 'battlefield'))]) {
        const inst = next.instances[id];
        if (inst === undefined) continue;
        const ch = characteristicsOf(next, inst);

        /*
          CR 704.5q: a permanent with both `+1/+1` and `-1/-1` counters on it loses that many of
          each, so the two kinds never sit on the same card.

          **The size was never wrong, which is why this was missing.** `characteristicsOf` reads
          both kinds and subtracts, so three plus and two minus has always *measured* as one plus —
          a 2/2 like that is a 3/3 either way, and nothing about power or toughness gives the gap
          away. What is wrong without this is every card that counts the counters themselves, and
          the pool has four kinds of them:

           - **Hangarback Walker** makes a Thopter per `+1/+1` counter as it dies. Three plus and two
             minus made three Thopters where the rules give one.
           - **Persist** asks whether the creature had a `-1/-1` counter, and **undying** whether it
             had a `+1/+1`. A persisted Murderous Redcap that then gains a plus counter is supposed
             to end with neither and be able to come back *again*; without annihilation it keeps both
             and persist stays switched off for good. That is the interaction the rule is famous for.
           - **Modular** moves `+1/+1` counters off a dying Arcbound creature, and **Walking
             Ballista** spends one to ping — both read a count this was inflating.

          **Reachable in this pool, not a theoretical gap.** `-1/-1` counters arrive here from
          **infect** (CR 702.90b, see `dealDamage`), so any Blight Vector creature connecting with a
          Hangarback Walker, a Ballista, an Arcbound creature or an undying body makes the board the
          rule is about — which a four-seat pod does by the second time those two decks meet.

          First in the pass, before the branches below that `continue`, so every count read by a
          death trigger this pass raises is already the right one.
        */
        const plus = inst.counters['+1/+1'] ?? 0;
        const minus = inst.counters['-1/-1'] ?? 0;
        if (plus > 0 && minus > 0) {
          const cancelled = Math.min(plus, minus);
          const counters = { ...inst.counters };
          if (plus - cancelled === 0) delete counters['+1/+1'];
          else counters['+1/+1'] = plus - cancelled;
          if (minus - cancelled === 0) delete counters['-1/-1'];
          else counters['-1/-1'] = minus - cancelled;
          next = withInstance(next, id, { counters });
          changed = true;
          continue;
        }

        /*
          CR 714.4: a Saga whose last chapter has gone is sacrificed.

          A state-based action rather than a fourth chapter, which is the rule and also the only
          version that behaves. What it checks is the **counters and an empty stack**, not whether
          an ability resolved — so a Saga whose last chapter is countered still goes away, and one
          whose counters were somehow removed stays. The stack check is the whole of the delay: the
          Saga sits there while chapter III waits to resolve, which is what makes "return a creature
          from a graveyard" able to see the board the chapter is about.
        */
        const chapters = sagaChapters(scriptForCard(next.cardDefs[inst.defKey]));
        if (chapters > 0 && (inst.counters['lore'] ?? 0) >= chapters
          && !next.stackOrder.some((objectId) => next.stackObjects[objectId]?.source === id)) {
          next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
          changed = true;
          continue;
        }

        /*
          CR 704.5m: an Aura attached to nothing, to something gone, or to something it may not
          legally enchant is put into its owner's graveyard.

          All three halves are needed and each one was missing in turn. The first is the one that
          bites most often: `relocate` detaches an Aura when its host leaves the battlefield, so by
          the time this runs the Aura is attached to *nothing* rather than to something illegal —
          checked for a gone host alone, a Pacifism outlives the creature it was on and sits on the
          battlefield forever.

          The third is **illegally attached while nothing moved at all**, which this engine could
          produce with two cards and did (#284). Animate a Mutavault, let the other seat enchant
          the 2/2, and at end of turn the animation wears off: the Aura is now on a land, which
          "enchant creature" does not allow. Nothing changed zone, so neither of the other two
          halves sees it, and the consequences ran both ways — a Pacifism answered the Mutavault
          for the rest of the game instead of for one turn, and a bestowed Boon Satyr stayed a
          non-creature Aura handing a *land* +4/+2 instead of standing up as the 4/2 its controller
          is owed.

          Asked of the Aura's own `enchant` restriction rather than of a hardcoded "is it still a
          creature", because the restriction is printed on the card and the engine already has it:
          `script.aura.target` is the spec the spell was cast with, and `BESTOW_TARGET` is the one
          a bestowed permanent was. See `isLegalAttachment` for why that is not the same question
          as `isLegalTarget` — hexproof gained under a Pacifism does not shed it, and protection
          does.

          An Aura with no spec to ask is left alone rather than binned. There is none in the pool;
          the fallback is which way to fail for a card added later, and keeping a permanent that
          may be fine beats destroying one that was.
        */
        if (hasSubtype(ch.typeLine, 'aura')) {
          const host = inst.attachedTo === null ? undefined : next.instances[inst.attachedTo];
          const enchant = inst.bestowed === true
            ? BESTOW_TARGET
            : scriptForCard(next.cardDefs[inst.defKey])?.aura?.target;
          const illegalHost = host !== undefined && host.zone === 'battlefield'
            && enchant !== undefined
            && !isLegalAttachment(next, enchant, host.id, inst.zoneSeat, inst.id);
          if (host === undefined || host.zone !== 'battlefield' || illegalHost) {
            /*
              Unless it was **bestowed**, in which case it stops being an Aura and becomes a
              creature where it stands (CR 702.103c).

              The one rule in this engine that changes a permanent's type without the permanent
              moving, and the whole reason the keyword is played: the removal spell aimed at the
              creature you enchanted leaves you a creature instead of two cards in the graveyard.
              Checked here rather than as a replacement effect because it is not one — the Aura
              never starts going to the graveyard, it simply stops meeting the condition that
              would send it.

              The pump goes with the attachment: `removeEffectsFrom` takes the bonus off by source
              id, the way the Equipment rule below does, or a dead creature's +4/+2 would sit in
              `effects` for the rest of the game.
            */
            if (inst.bestowed === true) {
              next = removeEffectsFrom(
                withInstance(next, inst.id, { attachedTo: null, bestowed: undefined }), inst.id,
              );
              changed = true;
              continue;
            }
            /*
              And the bonus goes with it, for the same reason the bestow branch above and the
              Equipment branch below say so — but here it took #284 to matter.

              `relocate` clears `attachedTo` on the way out and leaves `effects` alone, which is
              invisible as long as the only way an Aura leaves is its host leaving first: an effect
              scoped to a card that is gone applies to nothing. An Aura binned off an **illegal
              host** is the case where the host is still standing there, so a Pacifism's "can't
              attack" would go to the graveyard and keep pacifying.
            */
            next = removeEffectsFrom(relocate(next, inst, 'graveyard', inst.owner, 'bottom'), inst.id);
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

    /*
      The legend rule (CR 704.5j): one player cannot keep two legendary permanents with the same
      name, so all but one go to their owners' graveyards.

      **Reachable in this pool by two routes, both inside one deck** (#270, D288). Forge Alliance
      runs **Blade of Selves**, whose myriad makes token copies of the attacking creature, and its
      commander **Balan** pulls every Equipment onto himself — so a Balan carrying the Blade attacks
      a pod and makes two more Balans, which the rules do not allow and which were each dealing
      commander damage towards the twenty-one that eliminates a player. Tidal Mind runs **Clone**,
      which can copy its own commander. A pasted list is the third route: deck legality is not
      checked anywhere, by design, so two of one legend is a list a player can hand the table.

      **Which one survives is a deviation, stated rather than hidden.** The rule says its controller
      *chooses*; this keeps the one earliest in that seat's battlefield order, which is the one that
      arrived first. Asking would mean `stateBasedActions` being able to stop and ask a question,
      and it is a pure `state -> state` function called inside `settle` — making it able to block is
      a bigger change than this rule is worth today. The automatic answer is also the one a player
      almost always gives: of a real Balan and two token copies of him, the real one is the keeper.

      Grouped by the **characteristics'** name rather than the card's, so a Clone that copied a
      legend counts as that legend (CR 707.2 gives the copy the copied name) — which is the whole of
      the Clone route.
    */
    for (const seatRecord of next.seats) {
      if (seatRecord.eliminated) continue;
      const byName = new Map<string, string[]>();
      for (const id of listAt(next, zoneKey(seatRecord.index, 'battlefield'))) {
        const inst = next.instances[id];
        if (inst === undefined) continue;
        const ch = characteristicsOf(next, inst);
        if (!isLegendary(ch.typeLine)) continue;
        const seen = byName.get(ch.name);
        if (seen === undefined) byName.set(ch.name, [id]);
        else seen.push(id);
      }
      for (const ids of byName.values()) {
        if (ids.length < 2) continue;
        // Everything after the first, which is the one that has been there longest.
        for (const id of ids.slice(1)) {
          const inst = next.instances[id];
          if (inst === undefined) continue;
          next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
          changed = true;
        }
      }
    }

    // A permanent whose static effect source has left stops applying it.
    const live = expireEffects(next, 'never' as ContinuousEffect['duration']);
    if (live.length !== next.effects.length) {
      next = { ...next, effects: live };
      changed = true;
    }

    /*
      CR 702.95b: a pair whose two members are no longer two creatures one player controls is
      broken.

      Last in the pass and deliberately, because what it reads is the board *after* this round of
      deaths: a Wolfir Silverheart that just died has already been moved, so the pair it was half of
      is ended by the time this looks. And it is a pass over the board rather than a hook on each
      way a pair can end, because one of those ways — a change of controller — moves nothing and
      raises nothing. See `breakEndedPairs`.
    */
    const unpaired = breakEndedPairs(next);
    if (unpaired !== next) {
      next = unpaired;
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
/** The answer when nothing moved, so the common case allocates no Set. */
const EMPTY_REPLACED: ReadonlySet<string> = new Set<string>();

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
function replaceZoneChange(
  state: GameState, on: ReplacementEvent, moving: readonly string[],
): { state: GameState; unreplaced: readonly string[]; replaced: ReadonlySet<string> } {
  if (moving.length === 0) return { state, unreplaced: moving, replaced: EMPTY_REPLACED };
  const sources: { id: string; controller: SeatIndex }[] = [];
  for (const seat of apnapSeats(state)) {
    for (const id of listAt(state, zoneKey(seat, 'battlefield'))) sources.push({ id, controller: seat });
  }
  let next = state;
  const replaced = new Set<string>();
  const survived: string[] = [];
  for (const id of moving) {
    // A token has already ceased to exist by the time this runs, and every printed version of this
    // effect says "nontoken" anyway — so there is nothing to replace and nothing to look at.
    const inst = next.instances[id];
    if (inst === undefined) {
      survived.push(id);
      continue;
    }
    let handled = false;
    /*
      The dying permanent's own effect first, and from the graveyard it has already reached.

      `sources` is everything on the battlefield, which by the time a replacement is asked the dying
      permanent is not — so a card that replaces its *own* death was unwritable until unearth needed
      one (D183: "exile it … or if it would leave the battlefield"). First rather than last because
      the choice between two applicable replacements belongs to the affected object's controller
      (CR 616.1), and a creature that is meant to be exiled is not handed to somebody else's Kalitas
      instead.
    */
    const candidates = [{ id, controller: inst.zoneSeat, own: true },
      ...sources.map((source) => ({ ...source, own: false }))];
    /*
      Madness, installed by the engine rather than written out by the card (CR 702.35a).

      First, before any other replacement, because it is the affected card's own and the choice
      between two applicable replacements belongs to the affected object's controller (CR 616.1) —
      the same reason the card's own `replaces` entries are asked before everybody else's. And only
      for a **discard**: a milled card, or one that has finished resolving as a spell, is in this
      same list and is not a discard at all.
    */
    const madness = on === 'to-graveyard' && next.discarded.includes(id)
      ? scriptOf(next, id)?.madness
      : undefined;
    if (madness !== undefined) {
      const named = next.cardDefs[inst.defKey]?.name ?? 'a card';
      next = madnessOffer(next, id, madness.cost);
      next = {
        ...next,
        replacements: [...next.replacements,
          `${named}: discarded into exile, to be cast for ${madness.cost} (madness)`],
      };
      replaced.add(id);
      continue;
    }
    for (const source of candidates) {
      if (!source.own && next.instances[source.id]?.zone !== 'battlefield') continue;
      for (const rule of scriptOf(next, source.id)?.replaces ?? []) {
        if (rule.on !== on) continue;
        const ctx = {
          state: next, subject: id, source: source.id, controller: source.controller,
          /*
            Whether this move was a **discard**, which only madness asks and only madness could.

            Read off the list `relocate` keeps rather than from the card's position, because by the
            time a replacement runs the card has already moved and the zone it came from is gone.
            See `GameState.discarded`.
          */
          discarded: next.discarded.includes(id),
        };
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
    if (handled) replaced.add(id);
    else survived.push(id);
  }
  return { state: next, unreplaced: survived, replaced };
}

/**
 * The dredge this seat could use for an owed draw, cheapest first (CR 702.52a).
 *
 * Two conditions and they are both the keyword's own. The card has to be **in the graveyard** —
 * dredge is an ability that works from there and nowhere else — and the library has to hold at
 * least `mill` cards, which is the half of the rule that keeps it from being a way to deck
 * yourself: a dredge you cannot pay for is not a dredge you may decline, it is one that is not
 * offered.
 *
 * The cheapest when there are several, which is the same "one at a time" concession
 * `tickSuspended` makes. A question that offered a choice between three dredge cards and a draw
 * would be a third kind of prompt, and the pool has no card that makes the choice interesting.
 */
function dredgeFor(
  state: GameState, seat: SeatIndex,
): { card: string; mill: number } | undefined {
  const library = listAt(state, zoneKey(seat, 'library')).length;
  let best: { card: string; mill: number } | undefined;
  for (const id of listAt(state, zoneKey(seat, 'graveyard'))) {
    const mill = scriptOf(state, id)?.dredge?.mill;
    if (mill === undefined || mill > library) continue;
    if (best === undefined || mill < best.mill) best = { card: id, mill };
  }
  return best;
}

/**
 * Mills for a dredge and puts the card back in its owner's hand (CR 702.52a).
 *
 * Shared by the two ways the answer can arrive: a player pressing the button, and a standing
 * answer the engine gives for them. The **mill happens first**, which is the order the rules put
 * them in and is not cosmetic — a dredge whose own mill turns up a second dredge card puts it in
 * the graveyard where the next draw can use it, and a graveyard read first would miss it.
 */
export function takeDredge(
  state: GameState, seat: SeatIndex, card: string, amount: number,
): GameState {
  const next = mill(state, seat, amount);
  const inst = next.instances[card];
  // Only still there to take back if its own mill did not move it, which it cannot — a card in a
  // graveyard is not on top of a library — but a state that moved underneath the answer is left
  // alone rather than forced.
  if (inst === undefined || inst.zone !== 'graveyard') return next;
  return relocate(next, inst, 'hand', inst.owner, 'bottom');
}

/**
 * Takes the draws the engine owes, asking about a dredge where there is one (CR 702.52a).
 *
 * The first thing `settle` does, before the lists of deaths and arrivals are drained, so a draw
 * deferred by `drawLater` reaches its `draws` trigger and its miracle offer in the *same* settle
 * pass an immediate draw would have — which is what makes the deferral invisible to everything
 * except dredge.
 *
 * It stops at the first question. An offer and a dredge are two stopped tables and the engine
 * holds one at a time, so a seat with a miracle on offer keeps its remaining owed draws until that
 * is answered; the queue is state, so it survives the wait.
 */
function drainOwedDraws(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 64; guard++) {
    if (next.pendingDredge !== null || next.pendingOfferedCast !== null) break;
    const seat = next.drawsOwed[0];
    if (seat === undefined) break;
    // A seat that has left the game is owed nothing.
    if (next.seats[seat]?.eliminated !== false) {
      next = { ...next, drawsOwed: next.drawsOwed.slice(1) };
      continue;
    }
    const dredge = dredgeFor(next, seat);
    if (dredge === undefined) {
      next = draw({ ...next, drawsOwed: next.drawsOwed.slice(1) }, seat, 1);
      continue;
    }
    const name = next.cardDefs[next.instances[dredge.card]?.defKey ?? '']?.name ?? 'a card';
    /*
      A standing answer, given once instead of every turn (see `GameState.dredgeStops`).

      Said out loud through the replacement channel either way, because this is the one path where
      cards move — three off a library, one out of a graveyard — with nobody pressing anything. A
      player who set "always" four turns ago should still be able to read what it did.
    */
    const standing = next.dredgeStops[String(seat)];
    if (standing === 'never') {
      next = draw({
        ...next,
        drawsOwed: next.drawsOwed.slice(1),
        replacements: [...next.replacements, `${name} was not dredged: you draw instead`],
      }, seat, 1);
      continue;
    }
    if (standing === 'always') {
      next = takeDredge({
        ...next,
        drawsOwed: next.drawsOwed.slice(1),
        replacements: [...next.replacements,
          `${name}: ${dredge.mill} milled and the card returned, instead of a draw`],
      }, seat, dredge.card, dredge.mill);
      continue;
    }
    next = {
      ...next,
      pendingDredge: {
        seat,
        card: dredge.card,
        mill: dredge.mill,
        prompt: `Dredge ${name}: mill ${dredge.mill} and return it to your hand instead of drawing?`,
      },
    };
  }
  return next;
}

function settle(state: GameState, before: GameState): GameState {
  let next = drainOwedDraws(stateBasedActions(state));
  // Deaths and arrivals, in a loop: a creature dying can trigger something that kills another or
  // makes a token, and every one of those has to reach its own trigger. `relocate` and
  // `createToken` record them wherever they happen — lethal damage, a destroy spell, a sacrifice,
  // a reanimation, a token — and this is the only place they are announced, so no caller can
  // forget to. Deaths before arrivals in each pass, because a creature that dies and leaves
  // something behind should see the death trigger go on the stack first.
  for (
    let pass = 0;
    pass < 32 && (next.died.length > 0 || next.entered.length > 0 || next.left.length > 0
      || next.dealtCombatDamage.length > 0 || next.drew.length > 0
      || next.toGraveyard.length > 0 || (next.exiled ?? []).length > 0);
    pass++
  ) {
    /*
      Replacements, widest wording first, before anything is announced.

      One move is replaced once (CR 614.1), and the three lists are the same move at three widths —
      a creature destroyed in combat is in `left`, `toGraveyard` and `died` all at once. So the
      wide wordings are asked first and whatever they handled is dropped from the narrower lists:
      an unearthed creature bounced by an opponent's Unsummon is exiled rather than handed back
      (D183's clause, finally covering the half that is not death), and a creature a Kalitas exiles
      instead of letting die did not reach a graveyard, so nothing that watches graveyards sees it.

      **Leaving still happened.** A permanent exiled rather than buried has left the battlefield,
      so `left` keeps it and the leave triggers fire; what it did not do is arrive where it was
      going.
    */
    const leaving = replaceZoneChange(next, 'leaves-battlefield', next.left);
    next = leaving.state;
    const buriedPass = replaceZoneChange(
      next, 'to-graveyard', next.toGraveyard.filter((id) => !leaving.replaced.has(id)),
    );
    next = buriedPass.state;
    const deaths = replaceZoneChange(
      next, 'dies',
      next.died.filter((id) => !leaving.replaced.has(id) && !buriedPass.replaced.has(id)),
    );
    next = deaths.state;
    const dead = deaths.unreplaced;
    const gone = next.left;
    const arrived = next.entered;
    const connected = next.dealtCombatDamage;
    const drawn = next.drew;
    /*
      A card whose *death* was replaced did not reach a graveyard either, so the narrow pass can
      take an id out of the wide list as well as the other way round. Nothing in the pool can see
      the difference today — Planar Void's exile guards on the card still being in a graveyard, so
      it was already a no-op — but "exiled instead" means the graveyard was never touched (CR
      614.6), and the next card that counts graveyards as it resolves would read it.
    */
    const buried = buriedPass.unreplaced.filter((id) => !deaths.replaced.has(id));
    /*
      And the cards that reached exile, which needs no replacement pass of its own.

      A replacement that sends a card to exile *instead* of a graveyard — Kalitas, unearth's end
      step — has already run by the time the move happens, so what is in this list is where the
      card really went. There is no printed effect that replaces being exiled, which is why
      `ReplacementEvent` has three members and not four.
    */
    const banished = next.exiled ?? [];
    /*
      And the spells copied onto the stack, which is magecraft's other half (see `GameState.copied`).

      A copy is not a cast (CR 707.12), so it cannot ride the cast event's own path — nothing
      announces a copy and no cost is paid for one. `copySpellOnStack` records it and this drains
      it, exactly as the zone-change family works.
    */
    const copies = next.copied ?? [];
    /*
      And the permanents turned over, which is the simplest member of the family: the flip has
      already moved `defKey`, so an id is the whole of what the event needs (see
      `GameState.transformed`).
    */
    const turned = next.transformed ?? [];
    /*
      And what came unattached on the way out, which is the one fact in this family that the board
      no longer holds by the time it is wanted: `relocate` detaches everything pointing at a card as
      it leaves, so a "when enchanted creature dies" trigger matched from here would find the Aura
      attached to nothing. See `GameState.detached`.
    */
    const detached = next.detached;
    next = {
      ...next,
      died: [], left: [], entered: [], dealtCombatDamage: [], drew: [], toGraveyard: [], exiled: [],
      copied: [], transformed: [], detached: {},
      // Drained here with the rest, and *after* the replacement passes above have read it: a
      // discard is a fact about a move that has already happened, and madness is the one thing
      // that asks about it.
      discarded: [],
    };
    /*
      Damage before deaths, because that is the order the two happened in: combat damage is dealt,
      and only then do state-based actions notice what it killed. Both triggers go on the stack
      together in the rules (CR 603.3b), and for one player's abilities the order within that is
      their own choice — so the engine takes the one that matches the sequence a player watched.
    */
    for (const { creature, defender } of connected) {
      /*
        A creature that deals combat damage to the monarch hands the crown to its controller
        (CR 720.5).

        Here rather than in `dealCombatDamage`, because this is the list of damage that actually
        landed — a swing stopped by a Fog, a shield or protection raises nothing and steals nothing,
        which is what "deals damage" means. Applied before the combat-damage triggers go on the
        stack, so a card that reads the crown reads it as it is after the hit.

        Immediately rather than as a triggered ability, which is the same simplification as the
        monarch's draw: nothing here can put an ability on the stack without a card to own it, so
        the crown moves and the log says so. At a real table the trigger could be countered.
      */
      const taker = next.instances[creature]?.zoneSeat;
      if (next.monarch !== null && defender === next.monarch && taker !== undefined
        && taker !== next.monarch && next.seats[taker]?.eliminated === false) {
        next = { ...next, monarch: taker };
      }
      next = raise(
        next, { kind: 'combat-damage', defender }, next.instances[creature]?.zoneSeat, creature,
      );
    }
    /*
      And **one** event per hit, which is a different question from the creatures that made it.

      "Whenever one or more creatures you control deal combat damage to a player" fires once however
      many of them connected — 26 legal corpus lines and 8 compilable cards, which D439 refused
      precisely because reading it off the loop above would pay a Grim Hireling per attacker. See
      the `combat-damage-dealt` event's own declaration, including why the batch is per **damaged
      player** rather than per combat.

      Grouped off `connected` rather than counted on the way through, because the key is a pair —
      whose creature, and who it hit — and a swing that splits between two opponents is two hits.
      The key is a string because that is what a `Set` can hold; the seats are read back off the
      entry rather than parsed out of it.
    */
    const hits = new Map<string, { readonly by: SeatIndex; readonly defender: SeatIndex }>();
    for (const { creature, defender } of connected) {
      const by = next.instances[creature]?.zoneSeat;
      if (by === undefined) continue;
      hits.set(`${by}:${defender}`, { by, defender });
    }
    for (const { by, defender } of hits.values()) {
      next = raise(next, { kind: 'combat-damage-dealt', defender }, by);
    }
    /*
      Draws, before the deaths and the arrivals in this pass.

      Order matters here for one reason and it is not subtle: a Chasm Skulker that draws a card as
      it dies should take its counter *before* the death trigger reads how many it has. Putting
      draws first is also the order a player watched — the card was drawn, and then whatever the
      drawing killed or made happened afterwards.

      One ability per card, which is what makes `drew` a list of entries rather than a count: three
      cards drawn is three triggers on the stack, each able to be answered on its own.
    */
    // The ordinal travels with the event, because the running total cannot tell the first card of a
    // `draw(2)` from the second by the time either trigger is matched. See the `draws` event's
    // `onNth`, and miracle's note below, which found the same thing first.
    for (const { seat, nth } of drawn) next = raise(next, { kind: 'draws', nth }, seat);
    /*
      And miracle, which is not a trigger at all — it is an offer, on the card that was drawn.

      Here because this is where the engine knows a card was *drawn* rather than put into a hand,
      and after the draw triggers because that is the order on the stack a player would see: the
      Chasm Skulker takes its counter, and then you are asked about the card. The condition is
      read off the entry's own `nth` rather than off `cardsDrawnThisTurn`, which by now has counted
      every card of a `draw(2)` and could not tell the first from the second.

      Only the first card, only while it is still in the hand it arrived in, and only one at a time:
      `pendingOfferedCast` holds one offer, so a turn that somehow drew two miracle cards first
      offers the earlier one — which is the right one, and the later card is an ordinary card in
      hand. Nothing in this pool can draw two first cards.
    */
    if (next.pendingOfferedCast === null) {
      for (const { card, nth } of drawn) {
        if (nth !== 1) continue;
        const inst = next.instances[card];
        if (inst === undefined || inst.zone !== 'hand') continue;
        const cost = scriptForCard(next.cardDefs[inst.defKey])?.miracle?.cost;
        if (cost === undefined) continue;
        next = miracleOffer(next, card, cost);
        break;
      }
    }
    for (const id of dead) {
      // The attachments travel with the event, not looked up from a board that has already let go
      // of them. An absent list and an empty one mean the same thing to the matcher, so the field
      // is only written when there was something on the creature.
      const were = detached[id];
      next = raise(
        next,
        { kind: 'dies', ...(were === undefined || were.length === 0 ? {} : { attachments: were }) },
        next.instances[id]?.zoneSeat,
        id,
      );
    }
    // Leaving comes after dying, so a card that does both raises the narrower event first and its
    // death trigger goes on the stack under the leave trigger — which is the order the rules put
    // them in for one event raising two abilities of the same controller.
    for (const id of gone) next = raise(next, { kind: 'leaves' }, next.instances[id]?.zoneSeat, id);
    /*
      And the card arriving in a graveyard, which is a different event from the death that often
      caused it and is raised after it.

      After, because a creature destroyed in combat is both at once and the narrower, older event
      should be the one underneath on the stack: a Blood Artist's drain goes on first and a Planar
      Void's exile on top of it, which is the order a player watching the table would describe.
      It also means the card is still in the graveyard when the death trigger resolves, which is
      what the rules say about a card that is exiled by something else's trigger afterwards.
    */
    for (const id of buried) {
      next = raise(next, { kind: 'to-graveyard' }, next.instances[id]?.zoneSeat, id);
    }
    /*
      And the exiles, after the graveyards for the same reason the graveyards come after the deaths:
      a card that was destroyed and then exiled by something else did both, and the earlier event
      belongs underneath on the stack.

      The event carries the three facts the move destroyed rather than letting `raise` read them off
      a card sitting in exile — see `ExiledCard`. `actor` is the seat that controlled it as it left,
      which is what makes "a creature **you** control" answerable: for every other event in this
      loop that argument is the seat the subject belonged to, and this is the same question asked
      before the zone change rather than after it.
    */
    for (const { types, subtypes, controller, colors, manaValue } of copies) {
      /*
        Raised as a `spell-cast` carrying `how: 'copied'` rather than as an event of its own.

        One event with a discriminator, because a card that watches both reads them as one thing —
        magecraft is a single triggered ability printed "cast **or** copy", and two events would
        make it two abilities on the stack for a card that has one. Everything that must *not* see
        a copy — storm, cascade, prowess, a Chalice of the Void — gets that for free from the
        matcher's default of `cast`.

        No `object`: the copy is a stack object with no card, and by the time this ability resolves
        it has resolved or been countered. Nothing printed with magecraft asks which spell it was.
      */
      next = raise(next, {
        kind: 'spell-cast', how: 'copied', types, subtypes, colors, manaValue,
      }, controller);
    }
    /*
      And the transforms, raised after the copies and before the arrivals for no reason beyond
      reading order: nothing in the pool watches two of these at once, and a permanent that
      transformed did not enter, die, leave or reach a graveyard.
    */
    for (const id of turned) {
      if (next.instances[id]?.zone !== 'battlefield') continue;
      next = raise(next, { kind: 'transformed' }, next.instances[id]?.zoneSeat, id);
    }
    for (const { card, from, controller, wasCreature } of banished) {
      next = raise(
        next,
        { kind: 'to-exile', cameFrom: from, subjectSeat: controller, subjectIsCreature: wasCreature },
        controller,
        card,
      );
    }
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
      // A face-down permanent has no abilities, so it has no replacement effect either: a morph
      // of a card that would enter tapped does not, because nothing on it says so (CR 707.2).
      const arrivalScript = isFaceDownPermanent(arrival) ? undefined
        // `scriptForCard`: a derived land that says "enters tapped" has to arrive tapped, or the
        // one line of text this module reads off a dual land would be the one it ignored.
        : scriptForCard(next.cardDefs[arrival.defKey]);
      if (!arrival.tapped && arrivalScript?.entersTapped === true) {
        next = withInstance(next, id, { tapped: true });
      }
      /*
        And its own static abilities, here rather than where the spell resolved.

        This used to live in the resolution of a permanent *spell*, which meant a permanent that
        arrived any other way had none of its printed statics: a reanimated Fog Bank prevented no
        damage, a Juggernaut put onto the battlefield by an effect did not have to attack, and a
        card moved onto the battlefield by hand — which is how every test builds a board — simply
        had no abilities. The trap caught three cards in a row before it was read as a bug.

        Arrivals are detected here, which makes this the one place that sees *every* way onto the
        battlefield. Installed before the entry trigger, like "enters tapped", because a static is
        true from the moment the permanent is there and a trigger may ask about it.

        Guarded on having no effect of its own already, which is what keeps it from doubling up on
        the aura effect a resolving aura installs with its own id as the source.
      */
      if (!next.effects.some((effect) => effect.source === id)) {
        next = applyStatics(next, id, arrival.zoneSeat, arrivalScript);
      }
      next = raise(next, { kind: 'etb' }, next.instances[id]?.zoneSeat, id);
      /*
        And a Saga's first lore counter, which is why it does something the turn it is cast
        (CR 714.2a).

        A replacement effect on the arrival rather than a chapter of its own, and placed here for
        the same reason "enters tapped" is: this loop is the one place that sees *every* way onto
        the battlefield, so a Saga reanimated or put there by an effect still starts counting.

        Guarded on having no counter yet, which is what stops a Saga that arrives, leaves and comes
        back from skipping chapter I — a returning Saga is a new object with no counters, and this
        reads the board rather than remembering.
      */
      if (sagaChapters(scriptForCard(next.cardDefs[arrival.defKey])) > 0
        && (next.instances[id]?.counters['lore'] ?? 0) === 0) {
        next = addLore(next, id, 1);
      }
      /*
        And the echo a permanent owes in its controller's next upkeep (CR 702.29b).

        Here for the reason the lore counter is: this loop is the one place that sees every way onto
        the battlefield, so an echo creature reanimated or put there by an effect owes its echo
        exactly as one that was cast does.

        A flag rather than a sum over `enteredTurn`, because the rule is "since your last upkeep"
        and that is not "this turn or last turn" in a pod: a creature that entered during an
        opponent's turn has had no upkeep of its controller's in between, and one that entered three
        opponents ago has had none either. See `CardInstance.echoDue`.
      */
      if (arrivalScript?.echo !== undefined && next.instances[id] !== undefined) {
        next = withInstance(next, id, { echoDue: true });
      }
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
  /*
    And the tokens that stopped existing are now finished with: their triggers are on the stack, so
    nothing needs their last state any more. Cleared here rather than left to grow, for the reason
    `died` and `left` are drained — a transient list that nobody empties is a memory leak with a
    game attached. An ability still resolving reads its source from the stack object, not from here.
  */
  /*
    And a permanent that left the battlefield stops being in anything's locked scope, because the
    thing that comes back is **a new object** (CR 400.7, #283, D304).

    Cloudshift is the card that makes this visible, and Verdant Guard runs it alongside Giant
    Growth: pump a Grizzly Bears to 5/5, blink it, and it used to come back **still 5/5**. A
    continuous effect applies to the object it was locked onto, and exiling a creature ends that
    object — so the 2/2 that returns is not the thing the Giant Growth was pumping. The engine
    reuses the instance id across a zone change, so an effect scoped to `{ kind: 'cards', ids }`
    found it again on the other side.

    **Here rather than in `relocate`, and the ordering is the reason — but the ordering is not
    currently observable, which is worth saying plainly rather than implying a reader that does not
    exist.** A leave-the-battlefield trigger is entitled to the game state as it was *before* the
    event (CR 608.2h), and that is what `vanished` is for; asking such a snapshot for a creature's
    **power** would consult `state.effects` by id, so stripping the effect at the moment the card
    moved would answer with the *unpumped* number. No card in this pool asks: the one script that
    reads a `vanished` instance at all is unearth's leave-replacement, and it reads a **counter**,
    which lives on the snapshot itself and never went through `effects`. So today either placement
    gives the same answers. This one is placed where it cannot go wrong later — by the time this line
    runs the triggers are on the stack and nothing needs the old state, which is already the
    invariant the `vanished` clear below relies on, so the two belong together.

    An id is taken **out of** a multi-card scope rather than the effect being dropped, because one
    creature leaving an Overrun does not un-pump the others; the effect goes only when its last
    subject has gone. Effects *sourced* from the departing card are a different question and have
    their own answer in `removeEffectsFrom`, which is what an Aura leaving uses.
  */
  const gone = new Set(Object.keys(next.vanished));
  if (gone.size > 0) {
    const effects = next.effects.flatMap((effect) => {
      if (effect.scope.kind !== 'cards') return [effect];
      const kept = effect.scope.ids.filter((id) => !gone.has(id));
      if (kept.length === effect.scope.ids.length) return [effect];
      return kept.length === 0 ? [] : [{ ...effect, scope: { ...effect.scope, ids: kept } }];
    });
    if (effects.length !== next.effects.length
      || effects.some((effect, i) => effect !== next.effects[i])) {
      next = { ...next, effects };
    }
  }
  if (Object.keys(next.vanished).length > 0) next = { ...next, vanished: {} };
  next = stateBasedActions(settleOffer(settlePayment(next)));
  /*
    And a dredge raised in this pass takes priority away, which `resetPriority` cannot do for it.

    Every other question is set by an action that ends in `resetPriority(settle(...))`, so the
    guard there is enough. A dredge is raised by the *draw step*, whose caller runs `advanceStep`
    first — and `advanceStep` hands priority out on its way through, before this function has seen
    the owed draw at all. So the invariant is restored here: nobody holds priority while the
    question stands.
  */
  if (next.pendingDredge !== null && next.priority !== null) {
    next = { ...next, priority: null, passed: [] };
  }
  return next;
}

/**
 * A ward nobody can pay is not a question (CR 702.21b).
 *
 * `wardAsks` sets the question and this answers the half of it that is not a choice: a player who
 * cannot produce the ward cost has one outcome available, and offering it as a button would be the
 * stuck-table bug the trigger-with-no-legal-targets rule exists to prevent. The check is here
 * rather than in `effects.ts` because "can this be afforded" is answered from `manaSources`, which
 * lives above that module — and nothing can change between the two points, because nobody holds
 * priority while a ward is outstanding.
 *
 * It is `canAfford` and not a second opinion about the pool, for the reason `legalActions` is: two
 * answers to "can this be paid" is how a table comes to offer a payment the engine then refuses.
 */
/**
 * Takes back an offered cast whose cost nobody can pay, because that is not a choice (CR 601.2h).
 *
 * The same rule as `settlePayment` below and for the same reason: a prompt with one button is
 * noise, and worse than noise here — a madness card offered to a player with no red mana would stop
 * the table to ask a question whose only answer is "no". So the engine answers it, and the card
 * finishes the move the replacement interrupted.
 *
 * Only an offer **with a cost**. Cascade's offer is free, so there is always something to decide.
 */
function settleOffer(state: GameState): GameState {
  const offer = state.pendingOfferedCast;
  if (offer === null) return state;
  /*
    And a **mandatory** offer with no legal way to take it, which is the one case where "there is
    nothing to decide" is not about mana (CR 702.62c).

    Suspend's cast cannot be declined, so an offer the seat cannot act on would be a table that has
    stopped for good: `legalActions` gives that seat the casts and no pass, and if there are no
    casts there is no move at all. Which is also exactly the rule — a suspended Rift Bolt with
    nothing to point at "remains exiled" — so the engine answers the question itself and says so.
    The card keeps the empty exile it is already in, because its time counters are gone and nothing
    offers it again.
  */
  if (offer.mandatory === true) {
    if (legalActions(state, offer.seat).plays.some((play) => play.offered === true)) return state;
    const name = state.cardDefs[state.instances[offer.card]?.defKey ?? '']?.name ?? 'a card';
    return {
      ...state,
      pendingOfferedCast: null,
      replacements: [...state.replacements, `${name} cannot be cast, so it remains exiled`],
    };
  }
  if (offer.cost === undefined || offer.cost === '') return state;
  const cost = parseManaCost(offer.cost);
  if (cost.unsupported === undefined
    && canAfford(poolOf(state, offer.seat), cost, manaSources(state, offer.seat))) return state;
  const named = state.cardDefs[state.instances[offer.card]?.defKey ?? '']?.name ?? 'a card';
  // Said in words through the channel the replacements use, because nothing was shown and nothing
  // was pressed: without a note the card simply turns up in a graveyard.
  const note = `${named}: ${offer.cost} could not be paid, so it is not cast`;
  let next: GameState = {
    ...state, pendingOfferedCast: null, replacements: [...state.replacements, note],
  };
  // And a miracle card nobody can pay for stays in the hand it was drawn into, which is the one
  // disposition that is not a move. See `pendingOfferedCast.stays`.
  if (offer.stays !== true && offer.toGraveyard === true) {
    const card = next.instances[offer.card];
    if (card !== undefined) next = relocate(next, card, 'graveyard', card.owner, 'bottom');
  }
  return next;
}

function settlePayment(state: GameState): GameState {
  const pending = state.pendingPayment;
  if (pending === null) return state;
  const cost = parseManaCost(pending.cost);
  if (canAfford(poolOf(state, pending.seat), cost, manaSources(state, pending.seat))) return state;
  /*
    And said in words, through the channel a replacement effect uses.

    This is the one path where a spell is answered without anybody pressing anything: no prompt was
    shown, because there was only one outcome, so without a note the player's removal simply
    vanishes off the stack. "A card the player cannot see working" is the same bug the replacement
    notes exist for, and the same fix.
  */
  const warded = state.cardDefs[state.instances[pending.source]?.defKey ?? '']?.name ?? 'a ward';
  const spell = state.stackObjects[pending.counters]?.description ?? 'it';
  const note = `${warded}: ward ${pending.cost} was not paid — ${spell} is countered`;
  return counterSpell(
    { ...state, pendingPayment: null, replacements: [...state.replacements, note] },
    pending.counters,
  );
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
    /*
      A consumed source is **sacrificed** rather than tapped, which is its printed cost: a Treasure
      says "{T}, Sacrifice this artifact: add one mana of any color", and the sacrifice is the half
      that matters because the permanent does not come back next untap step.

      Tapped as well as sacrificed, in that order, so the two facts are both true of the object that
      left: `{T}` is part of the cost, a tapped Treasure cannot pay it, and anything watching the
      tap sees one. The sacrifice goes through `relocate` for the reason every other sacrifice does
      — a token put into a graveyard ceases to exist there, and that is one rule in one place.
    */
    next = withInstance(next, pick.key, { tapped: true });
    if (pick.sacrifices === true) {
      const inst = next.instances[pick.key];
      if (inst !== undefined) next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
    }
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
  state: GameState, seat: SeatIndex, costText: string | ManaCost | undefined, x: number,
  extraGeneric = 0, avoid?: string,
): { state: GameState; tapped: readonly string[] } {
  // A cost already worked out, rather than one to parse: convoke hands over what is *left* of a
  // cost after the creatures it tapped, and re-deriving it from text would lose that.
  const printed = typeof costText === 'object' && costText !== null
    ? costText
    : parseManaCost(costText);
  // `extraGeneric` is the commander tax (CR 903.8): generic mana on top of the printed cost, which
  // the card itself has not changed.
  const cost = extraGeneric > 0 ? { ...printed, generic: printed.generic + extraGeneric } : printed;
  let next = state;
  let tapped: readonly string[] = [];
  if (!canPay(poolOf(next, seat), cost, x)) {
    const sources = manaSources(next, seat);
    /*
      `avoid` is the permanent whose own ability is being paid for, kept out of the sources unless
      nothing else can cover the cost.

      Legal either way — a Mutavault may tap itself for the {1} that animates it — and nearly
      always wrong: it turns the 2/2 it just became into a tapped 2/2 that cannot attack, which is
      the whole point of the card gone. Measured before this: **not one attack with an animated
      land in 56 games**, because the ability had tapped it every time. The fallback keeps a cost
      payable when the permanent's own mana is the only mana there is.
    */
    const preferred = avoid === undefined ? sources : sources.filter((source) => source.key !== avoid);
    const plan = solveTap(poolOf(next, seat), cost, preferred, x)
      ?? (preferred.length === sources.length ? null : solveTap(poolOf(next, seat), cost, sources, x));
    if (plan !== null) {
      next = tapSources(next, seat, plan);
      tapped = plan.map((pick) => pick.key);
    }
  }
  const result = payCost(poolOf(next, seat), cost, x);
  if (!result.paid) {
    const asText = typeof costText === 'string' || costText === undefined ? costText : null;
    const shown = asText === null
      ? 'what was left of its cost'
      : extraGeneric > 0 ? `${asText ?? '{0}'} +{${extraGeneric}}` : asText ?? '{0}';
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
/**
 * The questions this stack object asks, with any a card computes resolved (CR 702.24b).
 *
 * The one funnel every reader of a card's questions goes through — the plan, the ask, the payment
 * for a priced answer, and the fallback when that payment turns out to be impossible — which is why
 * `DecisionSpecOf` could be widened to "a spec, or a function of the state and the source" without
 * a single consumer downstream learning that a question can be computed. Cumulative upkeep is the
 * card that needed it: its price is its cost for each age counter on it, so the words, the prompt
 * and the cost are facts about this resolution rather than about the card.
 *
 * Resolved afresh on each call rather than once and remembered, because the alternative is a second
 * place for the answer to live. The contract that makes that safe is on `DecisionSpecOf`: the
 * function is pure and reads nothing that can change between the question and its answer.
 */
function decisionSpecsFor(state: GameState, object: StackObject): readonly DecisionSpec[] {
  const asked = (specs: readonly DecisionSpecOf[]): readonly DecisionSpec[] =>
    specs.map((spec) => (typeof spec === 'function' ? spec(state, object.source) : spec));
  const script = scriptOnStack(state, object);
  if (object.kind !== 'spell') return asked(abilityOrTrigger(script, object)?.decisions ?? []);
  const modes = modesOf(script, object.modes);
  if (modes.length > 0) return asked(modes.flatMap((mode) => [...(mode.decisions ?? [])]));
  return asked(script?.decisions ?? []);
}

/** The half of a card that runs before its questions are asked. Spell-level only. */
function beforeDecisionsFor(state: GameState, object: StackObject): EffectFn | undefined {
  const script = scriptOnStack(state, object);
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

/** Whether a seat is carrying any counter at all: poison, energy, anything a card put there. */
const seatHasCounters = (state: GameState, seat: SeatIndex): boolean =>
  (state.seats[seat]?.poison ?? 0) > 0
  || Object.values(state.seats[seat]?.counters ?? {}).some((n) => n > 0);

/**
 * Everything proliferate may be pointed at: permanents and players already carrying a counter.
 *
 * "Already carrying" is the rule and it is also what keeps the question answerable — a list of
 * every permanent on the table would make the player hunt for the three that matter.
 *
 * A **permanent**, which is narrower than "anything with counters on it": a suspended card in exile
 * has time counters and is not a permanent, so proliferate cannot hurry it along. That is true in
 * paper for the same reason and it is the one thing about this keyword people get wrong.
 */
export function proliferateCandidates(state: GameState): string[] {
  const permanents = state.seats.flatMap((seat) => listAt(state, zoneKey(seat.index, 'battlefield')))
    .filter((id) => Object.values(state.instances[id]?.counters ?? {}).some((n) => n > 0));
  const players = state.seats
    .filter((seat) => !seat.eliminated && seatHasCounters(state, seat.index))
    .map((seat) => `${SEAT_CHOICE}${seat.index}`);
  return [...permanents, ...players];
}

/** The cards in the chooser's own zone that a decision would accept. */
export function decisionCandidates(
  state: GameState, spec: CardsDecisionSpec, chooser: SeatIndex,
): string[] {
  // `library-top` is the top few cards of the chooser's own library rather than a whole zone —
  // scry looks at two cards, not at fifty-three, and the candidate list is also the authorisation
  // the answer is checked against, so taking the slice here is what stops a crafted answer
  // reaching the rest of the deck.
  const inZone = spec.from === 'library-top'
    ? listAt(state, zoneKey(chooser, 'library')).slice(0, Math.max(0, spec.look ?? 1))
    // The one question that crosses the table: every battlefield, in seat order, which is the
    // order the table reads in. See `DecisionZone`.
    : spec.from === 'any-battlefield'
      ? state.seats.flatMap((seat) => listAt(state, zoneKey(seat.index, 'battlefield')))
      : listAt(state, zoneKey(chooser, spec.from));
  return inZone.filter((id) => {
    if (state.instances[id] === undefined) return false;
    return spec.filter === undefined || spec.filter(state, id, chooser);
  });
}

/** How many a decision asks for, clamped to what the chooser actually has. */
function decisionBounds(
  spec: CardsDecisionSpec | CountersDecisionSpec, available: number,
): { min: number; max: number } {
  // "Any number" for proliferate, which is what the keyword says: nought to everything. The other
  // shapes default to exactly one.
  const wanted = isCountersDecision(spec) ? available : (spec.max ?? 1);
  const floor = isCountersDecision(spec) ? 0 : (spec.min ?? 1);
  const max = Math.min(spec.max ?? wanted, available);
  return { min: Math.min(spec.min ?? floor, max), max };
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
/**
 * Whether a seat can pay the price on one answer, in mana or in energy (D451).
 *
 * One function because it is asked **twice** about the same answer and the two readings must not
 * drift: once when the question is asked, to decide whether the priced option is offered at all
 * (CR 601.2h — the same discipline `legalActions` keeps about plays), and once when the answer
 * comes back, because a client is free to send an `auto:decide` naming a word that was never
 * offered. The comment at the second call site says that in full.
 *
 * `cost.unsupported` counts as unpayable rather than throwing: a mana string this engine cannot
 * parse is a card bug, and a card bug that silently charged nothing would be worse than an answer
 * that is never offered.
 */
function canPayForAnswer(
  state: GameState, seat: SeatIndex,
  price: { readonly cost?: string; readonly energy?: number },
): boolean {
  if (price.energy !== undefined) return energyOf(state, seat) >= price.energy;
  const cost = parseManaCost(price.cost ?? '');
  return cost.unsupported === undefined
    && canAfford(poolOf(state, seat), cost, manaSources(state, seat));
}

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
    /*
      A question the card says to ask **only if** an earlier answer was a particular word (D450).
      See `CardsDecisionSpec.askOnlyIfChosen`: this is what lets "you may search your library …"
      ask the yes-or-no first and open the library only on a yes.

      Read from the most recent earlier answer that carries an option at all, which is a choice
      question's answer — `each-opponent` expands into several plan entries, so counting back a
      fixed number of places would be counting something the card cannot know.

      The skip is an **empty answer** rather than a gap, so the positions every effect indexes by
      do not shift under it.
    */
    if (spec.askOnlyIfChosen !== undefined) {
      const chosen = [...answers].reverse().find((answer) => answer.option !== undefined)?.option;
      if (chosen !== spec.askOnlyIfChosen) {
        answers = [...answers, { seat: entry.seat, ids: [] }];
        continue;
      }
    }
    // Nothing already chosen by this seat earlier in the same resolution. Answers are applied by
    // the effect at the end, not as the questions are asked — which is right, because "each player
    // sacrifices a creature" is simultaneous and the second player must not see the first's
    // creature already gone. The consequence is that two questions put to the *same* seat from the
    // same zone would otherwise offer the same card twice, so they are taken out here.
    /*
      A question whose answer is a word takes a different path and a shorter one.

      There is no zone to read, nothing already chosen to take out, and no count to clamp — the
      options are the options. The one thing it shares with a card question is when the engine
      answers it instead of asking: a list of fewer than two words has one possible answer, and a
      prompt with one button is noise. See `ChoiceDecisionSpec`.
    */
    if (isChoiceDecision(spec)) {
      /*
        An option with a price on it is only offered to a seat that can pay it (CR 601.2h).

        The same discipline `legalActions` keeps about plays, for the same reason: a table that
        offered "Pay {W/B}" to a player with no untapped land would be offering an answer the
        engine then has to take back. Filtering here rather than refusing later also gives the
        empty case for free — one word left is a question the engine answers itself, so an extort
        trigger with no mana up resolves without stopping the table at all.
      */
      const options = spec.payIfChosen === undefined
        ? spec.options
        : spec.options.filter((word) => word !== spec.payIfChosen?.option
          || canPayForAnswer(state, entry.seat, spec.payIfChosen));
      if (options.length < 2) {
        answers = [...answers, {
          seat: entry.seat, ids: [], ...(options[0] === undefined ? {} : { option: options[0] }),
        }];
        continue;
      }
      return {
        state: {
          ...state,
          priority: null,
          passed: [],
          pendingDecision: {
            seat: entry.seat, stackId: object.id, prompt: spec.prompt,
            candidates: [], min: 1, max: 1, options: [...options],
            resume: { plan: [...plan], at: i, answers: [...answers] },
          },
        },
        message: `${object.description} — ${seatName(state, entry.seat)}: ${spec.prompt}`,
      };
    }
    /*
      A question whose answer is a **number**, which is the third shape and the shortest of all.

      The range is the card's, computed now rather than when the spell was cast — Toxic Deluge asks
      for what this player's life can pay and what the board makes worth paying, and both may have
      changed while the spell sat on the stack. A range with one answer in it is not a question: the
      engine takes that answer, the same way a list of one word is taken above.
    */
    if (isNumberDecision(spec)) {
      const { min, max } = spec.range(state, entry.seat);
      const low = Math.max(0, Math.floor(min));
      const high = Math.max(low, Math.floor(max));
      if (low === high) {
        answers = [...answers, { seat: entry.seat, ids: [], amount: low }];
        continue;
      }
      return {
        state: {
          ...state,
          priority: null,
          passed: [],
          pendingDecision: {
            seat: entry.seat, stackId: object.id, prompt: spec.prompt,
            candidates: [], min: 1, max: 1, numbers: { min: low, max: high },
            resume: { plan: [...plan], at: i, answers: [...answers] },
          },
        },
        message: `${object.description} — ${seatName(state, entry.seat)}: ${spec.prompt}`,
      };
    }
    /*
      A question whose answer is a **target** for something else on the stack — the fourth shape,
      and "you may choose new targets for the copy".

      Asked about the object being copied rather than about the copy, which does not exist yet: a
      copy's characteristics are the original's (CR 707.2), so the legal targets are the same set,
      and the answer is handed to `copySpellOnStack` as the copy is made. See `TargetDecisionSpec`.

      Three ways there is no question, and all three are "one possible answer" rather than a
      refusal: the object has left the stack, it has no single target spec to re-aim (no targets,
      or several, or a divided quantity the rules copy as it was divided — CR 706.10c), or the only
      legal target is the one it already has. Declining is an answer, so the engine declining on
      the player's behalf is the same outcome they would have chosen.
    */
    if (isTargetDecision(spec)) {
      const aimedId = spec.retargets(state, object);
      const aimed = aimedId === undefined ? undefined : state.stackObjects[aimedId];
      const aimedSpec = aimedId === undefined ? null : soleTargetSpecOf(state, aimedId);
      const current = aimed?.targets[0];
      /*
        Judged for the object being copied: its own controller chooses (so hexproof is hexproof
        against *them*), and its own source is what protection and "another target" are measured
        from — which for a spell is its card and for an ability is the permanent it came from, the
        same split `retarget` makes.
      */
      const choices = aimed === undefined || aimedSpec === null || current === undefined
        ? []
        : legalTargets(
          state, aimedSpec, aimed.controller,
          aimed.kind === 'spell' ? aimed.id : aimed.source,
        );
      const elsewhere = choices.filter((t) => targetKey(t) !== targetKey(current!));
      if (elsewhere.length === 0) {
        answers = [...answers, { seat: entry.seat, ids: [] }];
        continue;
      }
      return {
        state: {
          ...state,
          priority: null,
          passed: [],
          pendingDecision: {
            seat: entry.seat, stackId: object.id, prompt: spec.prompt,
            // Every legal target, the one it already has included: "you may choose new targets"
            // includes choosing the same ones, and a list that left it out would make keeping them
            // a different button from taking them.
            candidates: [], min: 0, max: 1, targetChoices: choices,
            resume: { plan: [...plan], at: i, answers: [...answers] },
          },
        },
        message: `${object.description} — ${seatName(state, entry.seat)}: ${spec.prompt}`,
      };
    }
    const taken = new Set(answers.filter((a) => a.seat === entry.seat).flatMap((a) => [...a.ids]));
    /*
      Proliferate's candidates come from the board rather than from a zone, and include players.

      The other four shapes all read a zone belonging to the chooser; this one reads **everything
      with a counter on it**, on either side of the table, plus the seats. See
      `proliferateCandidates` and `CountersDecisionSpec`.
    */
    const candidates = (isCountersDecision(spec)
      ? proliferateCandidates(state)
      : decisionCandidates(state, spec, entry.seat)).filter((id) => !taken.has(id));
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
        // Which shape this is, said rather than inferred: proliferate's candidates are sometimes
        // all cards (nobody has poison yet), and a reader guessing from the list would draw that
        // board's question as an ordinary one. See `pendingDecision.counters`.
        ...(isCountersDecision(spec) ? { counters: true as const } : {}),
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
  state: GameState, chosen: readonly string[], option?: string, amount?: number, target?: Target,
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
  /*
    Scry and surveil: the cards chosen leave the top and the rest stay there, in the order they
    were already in. Done here rather than by the card, because putting them back is part of the
    keyword and not part of what the spell does afterwards — Preordain's own effect is the draw.
    No shuffle: a scry that shuffled would be a very different card.

    **Where they go is the card's to say** (`CardsDecisionSpec.chosenGoTo`, D452): the bottom of
    the library for scry, the graveyard for surveil. The spec is read back through the resume plan
    rather than carried on the pending decision, because the pending decision crosses the wire to
    every seat and this is not something a client needs to be told.
  */
  if (pending.from === 'library-top') {
    const key = zoneKey(pending.seat, 'library');
    const picked = chosen.filter((id) => pending.candidates.includes(id));
    const asked = object === undefined
      ? undefined
      : decisionSpecsFor(next, object)[pending.resume.plan[pending.resume.at]?.specIndex ?? -1];
    const destination = asked !== undefined && 'chosenGoTo' in asked ? asked.chosenGoTo : undefined;
    if (picked.length > 0 && destination === 'graveyard') {
      next = moveToGraveyard(next, picked);
    } else if (picked.length > 0) {
      const rest = listAt(next, key).filter((id) => !picked.includes(id));
      next = withZones(next, { [key]: [...rest, ...picked] });
    }
  }
  // The object leaving the stack mid-resolution should not be possible — nothing else can happen
  // while a decision is outstanding — but a resolution with nothing to resolve is simply over.
  if (object === undefined) return { state: next, message: 'that resolution is gone' };
  const answers = [...pending.resume.answers, {
    seat: pending.seat, ids: [...chosen],
    ...(option === undefined ? {} : { option }),
    ...(amount === undefined ? {} : { amount }),
    ...(target === undefined ? {} : { target }),
  }];
  return askOrFinish(next, object, pending.resume.plan, pending.resume.at + 1, answers);
}

/**
 * Which word the engine's opponent would pick for the question that is outstanding.
 *
 * Here rather than in `bot.ts` because answering it needs the *spec*, and the spec is reached
 * through `decisionSpecsFor` — the stack object says which ability is resolving and the script
 * says what it asks. The bot has no business knowing either. See `ChoiceDecisionSpec.best`.
 */
export function preferredOption(state: GameState): string | undefined {
  const pending = state.pendingDecision;
  if (pending === null || pending.options === undefined) return undefined;
  const object = state.stackObjects[pending.stackId];
  if (object === undefined) return pending.options[0];
  const specs = decisionSpecsFor(state, object);
  const spec = specs[pending.resume.plan[pending.resume.at]?.specIndex ?? -1];
  const picked = spec !== undefined && isChoiceDecision(spec)
    ? spec.best?.(state, pending.seat)
    : undefined;
  // Only a word the question actually offered: a card's own hint is still checked against the
  // list, because a hint that named something else would be a refused action and a stopped table.
  return picked !== undefined && pending.options.includes(picked) ? picked : pending.options[0];
}

/**
 * Which **cards** the engine's opponent would pick for the question that is outstanding.
 *
 * The card twin of `preferredOption`, reached the same way and for the same reason: the spec lives
 * behind `decisionSpecsFor` and the bot has no business knowing which ability is resolving. See
 * `CardsDecisionSpec.pick`, and `decideCards` for the standing answers this overrides.
 *
 * Returns undefined when the card wrote no hint, which is almost always, and filters whatever it
 * did write down to ids the question actually offered.
 */
export function preferredCards(state: GameState): readonly string[] | undefined {
  const pending = state.pendingDecision;
  if (pending === null || pending.from === undefined) return undefined;
  const object = state.stackObjects[pending.stackId];
  if (object === undefined) return undefined;
  const specs = decisionSpecsFor(state, object);
  const spec = specs[pending.resume.plan[pending.resume.at]?.specIndex ?? -1];
  if (spec === undefined || !isCardsDecision(spec)) return undefined;
  const picked = spec.pick?.(state, pending.seat, pending.candidates);
  if (picked === undefined) return undefined;
  return picked.filter((id) => pending.candidates.includes(id)).slice(0, pending.max);
}

/**
 * Which number the engine's opponent would pick for the question that is outstanding.
 *
 * The number twin of `preferredOption`, and here for the same reason: answering it needs the spec,
 * and the spec is reached through the stack object and the script. A card's own hint is clamped to
 * the range the question actually offered — a hint outside it would be a refused action and a
 * stopped table — and the bottom of the range is the fallback, because that is the answer that
 * does least.
 */
export function preferredAmount(state: GameState): number | undefined {
  const pending = state.pendingDecision;
  if (pending === null || pending.numbers === undefined) return undefined;
  const { min, max } = pending.numbers;
  const object = state.stackObjects[pending.stackId];
  if (object === undefined) return min;
  const specs = decisionSpecsFor(state, object);
  const spec = specs[pending.resume.plan[pending.resume.at]?.specIndex ?? -1];
  const picked = spec !== undefined && isNumberDecision(spec)
    ? spec.best?.(state, pending.seat)
    : undefined;
  if (picked === undefined || !Number.isFinite(picked)) return min;
  return Math.min(max, Math.max(min, Math.floor(picked)));
}

/**
 * What the outstanding question is re-aiming, for whoever has to answer it.
 *
 * The third of the same family as `preferredOption` and `preferredAmount`, and the only one that
 * does not answer the question: "where should this go" cannot be answered by the card, because the
 * card being copied is not the card asking. What the asker needs instead is three facts about the
 * object being re-aimed — which object it is, what it is pointed at now, and whether the spell's
 * own spec is `friendly` — and all three are reachable only from here, because the question's spec
 * is found through the stack object and the script.
 *
 * `friendly` is the whole of what makes this answerable at all. The bot aims at the enemy by
 * default, which is right for a copied Doom Blade and exactly wrong for a copied prevention
 * shield; the flag travels on the *copied spell's* target spec, where the card that knows put it.
 * The same hint, read the same way, as `chooseTargets` reads for a cast.
 */
export function pendingRetarget(state: GameState): {
  readonly object: string;
  readonly current: Target | undefined;
  readonly friendly: boolean;
} | undefined {
  const pending = state.pendingDecision;
  if (pending === null || pending.targetChoices === undefined) return undefined;
  const object = state.stackObjects[pending.stackId];
  if (object === undefined) return undefined;
  const specs = decisionSpecsFor(state, object);
  const spec = specs[pending.resume.plan[pending.resume.at]?.specIndex ?? -1];
  if (spec === undefined || !isTargetDecision(spec)) return undefined;
  const aimedId = spec.retargets(state, object);
  const aimed = aimedId === undefined ? undefined : state.stackObjects[aimedId];
  if (aimedId === undefined || aimed === undefined) return undefined;
  return {
    object: aimedId,
    current: aimed.targets[0],
    friendly: soleTargetSpecOf(state, aimedId)?.friendly === true,
  };
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

  const script = scriptOnStack(state, object);
  const specs = targetSpecsFor(state, script, object);

  /*
    The intervening-if clause, asked the second of its two times (CR 603.4).

    First, before anything else this resolution does: a trigger whose condition has become false
    is removed from the stack and does nothing — it does not resolve partway, and it does not
    fizzle, which is a different outcome with a different message. The window between the two asks
    is exactly the window an opponent gets, so this is the half of the rule that makes killing the
    creature an evolve trigger measured a real answer rather than a tempo loss.
  */
  const trigger = object.kind === 'triggered' ? abilityOrTrigger(script, object) : undefined;
  if (trigger?.condition !== undefined && !trigger.condition({
    state,
    source: object.source,
    controller: object.controller,
    targets: object.targets,
    x: object.x ?? 0,
    decisions: [],
    kicked: object.kicked === true,
    attacked: object.attacked,
    // `aboutNow`, not the raw ids: a subject blinked in response is a new object (CR 400.7).
    ...aboutNow(state, object),
    answering: object.answering,
    subjectCounters: object.subjectCounters,
    enteringAttack: object.enteringAttack,
  })) {
    const next = popStack(state, object.id);
    const name = next.cardDefs[object.cardKey]?.name ?? 'it';
    return { state: next, message: `${name} does nothing: its condition is no longer true` };
  }

  /*
    A target that is no longer the object it was chosen as is gone, however legal it looks.

    Dropped before the fizzle check rather than inside it, so that a spell with two targets that
    lost one resolves against the one it still has and the effect never sees the other. This is
    what makes a Cloudshift in response to a Doom Blade do what the card is for.
  */
  const chosen = object.targets;
  const live = liveTargets(state, chosen, object.targetSeqs);
  if (live.length !== chosen.length) {
    /*
      A divided quantity loses the share of the target that went with it, and only that share
      (CR 608.2b). Filtered in the same breath as the targets so the two lists stay aligned
      position by position — the one thing everything downstream assumes about them — and not
      redistributed: three damage split two and one, with the two-damage creature bounced in
      response, deals one. A Cloudshift answering an Arc Lightning saves exactly what it was
      pointed at.
    */
    const was = object;
    const division = was.division === undefined
      ? undefined
      : chosen.flatMap((target, i) => (
        stillTheObject(state, target, was.targetSeqs) ? [was.division?.[i] ?? 0] : []
      ));
    object = {
      ...object, targets: live, ...(division === undefined ? {} : { division }),
    };
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
      if (inst !== undefined) next = spellLeavesStack(next, object, inst);
    }
    return { state: next, message: `${name} is countered: its targets are gone` };
  }

  const wanted = decisionSpecsFor(state, object);
  if (wanted.length > 0) {
    // The half of the card that comes before its question. See `CardScript.beforeDecisions`.
    const first = beforeDecisionsFor(state, object);
    const ready = first === undefined ? state : first({
      state, source: object.source,
      controller: object.controller, targets: object.targets, x: object.x ?? 0, decisions: [],
      kicked: object.kicked === true, attacked: object.attacked,
      ...aboutNow(state, object),
      answering: object.answering,
      actor: object.actor, subjectCounters: object.subjectCounters,
      enteringAttack: object.enteringAttack,
      ...(object.division === undefined ? {} : { division: object.division }),
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
  const script = scriptOnStack(next, object);

  /*
    An answer with a price on it, paid before the effect runs (CR 601.2h).

    Extort is the card that needed this: "you may pay {W/B}" is a question whose *answer* costs
    mana, and the card cannot pay it itself — paying means tapping lands, and the only thing that
    taps lands is this file. So the engine pays here, between the question being answered and the
    effect being run, and the effect reads an answer that has already been paid for.

    The affordability check at ask time (see `askOrFinish`) is what makes this safe, and it is
    re-asked here rather than trusted: nothing can spend this seat's mana between the two moments,
    but a client is free to send an `auto:decide` naming a word that was never offered, and an
    unpaid extort that drained an opponent anyway would be the engine lying about a cost.
  */
  const priced = decisionSpecsFor(next, object)
    .flatMap((spec) => (isChoiceDecision(spec) && spec.payIfChosen !== undefined
      ? [spec.payIfChosen]
      : []));
  let paidAnswers = answers;
  for (const price of priced) {
    const chosen = paidAnswers.findIndex((answer) => answer.option === price.option);
    if (chosen < 0) continue;
    const seat = paidAnswers[chosen]!.seat;
    if (!canPayForAnswer(next, seat, price)) {
      // Not payable after all, so the answer was never available: it reads as the first option,
      // which is the word the card puts first for exactly this reason.
      const fallback = decisionSpecsFor(next, object)
        .flatMap((spec) => (isChoiceDecision(spec) ? [spec.options[0]] : []))[0];
      paidAnswers = paidAnswers.map((answer, i) => (i === chosen
        ? { ...answer, ...(fallback === undefined ? {} : { option: fallback }) }
        : answer));
      continue;
    }
    next = price.energy === undefined
      ? payFrom(next, seat, parseManaCost(price.cost ?? ''), 0).state
      : spendEnergy(next, seat, price.energy);
  }
  answers = paidAnswers;

  const ctx: EffectContext = {
    state: next,
    /*
      The card this resolution is from.

      `source` is the same as `id` for every spell that was cast — both are its card instance — and
      for a *copy* of a spell it is the original's card, which is the one that still exists. So
      reading `source` is right in both cases and the ternary this used to be was not: a copy's own
      id is nothing in `instances`, and an effect that went looking for its characteristics there
      would find a spell with no card. See `copySpellOnStack`.
    */
    source: object.source,
    controller: object.controller,
    targets: object.targets,
    x: object.x ?? 0,
    decisions: answers,
    kicked: object.kicked === true,
    attacked: object.attacked,
    /*
      Which permanent it is about, for a trigger that has to say "that creature" — and which
      creature it blocked, for the other half of the same question.

      Through `aboutNow` rather than read off the object, because an id is not an identity across
      a zone change: a creature blinked while this ability sat on the stack comes back wearing the
      same id and is a different object (CR 400.7). Both ids go the same way because both answer
      "which object", and the Basilisk reads the second one.
    */
    ...aboutNow(state, object),
    // What this ability is about, for a ward that has to counter a particular object.
    answering: object.answering,
    // And what that permanent had on it before the event, for one that counts counters that are
    // gone by now. See `StackObject.subjectCounters`.
    subjectCounters: object.subjectCounters,
    // And the attack it is about to join, for a ninja arriving mid-combat.
    enteringAttack: object.enteringAttack,
    // And whose action it was, for one that has to say "that player".
    actor: object.actor,
    // And how a divided quantity was split, for the one card shape that announces numbers with
    // its targets. Filtered to match `targets` above.
    ...(object.division === undefined ? {} : { division: object.division }),
  };

  if (object.kind === 'spell') {
    const inst = next.instances[object.id];
    const def = next.cardDefs[object.cardKey];
    const isPermanent = inst !== undefined && isPermanentCard(def);
    const modes = modesOf(script, object.modes);
    /*
      Which effect this spell has is a question for the first time here, and the answer is on the
      stack object.

      An overloaded spell runs the card's *other* effect (CR 702.96a): "each instance of target"
      became "each", which is a different sentence rather than a bigger number, so the card writes
      it out as its own function and this picks between them. Checked before the modes because a
      card cannot be both — nothing printed has overload and modes, and if one did, the overload
      text would be what replaced the modal text.
    */
    if (object.overloaded === true && script?.overload !== undefined) {
      next = script.overload.onResolve({ ...ctx, state: next });
    }
    // A modal spell's effect is its chosen modes, in printed order; everything else has one.
    else if (modes.length > 0) next = runModes(next, modes, { ...ctx, state: next });
    else if (script?.onResolve) next = script.onResolve({ ...ctx, state: next });
    if (isPermanent && inst !== undefined) {
      next = relocate(next, requireInstance(next, inst.id), 'battlefield', object.controller, 'bottom');
      /*
        "Enters the battlefield with N +1/+1 counters on it" (CR 614.1c), applied here because
        this is the only place the X it was cast for is known: a creature put onto the battlefield
        by something else — reanimated, or made as a token — enters with X of zero, which is what
        the rules say rather than a simplification.
      */
      /*
        "If its evoke cost was paid" — recorded on the permanent as it arrives (CR 702.74a).

        Here for the same reason `entersWith` is here: this is the last moment anything knows how
        the spell was paid for. The stack object is about to be gone, and the trigger that reads
        this fact resolves afterwards, from the battlefield, where a Mulldrifter cast for {4}{U}
        and one cast for {2}{U} are the same card.

        Before the arrival is announced, which matters: `settle` is what puts the card's entry
        triggers on the stack, and the sacrifice trigger's intervening-if clause is asked as it
        triggers (CR 603.4). A counter written afterwards would be a counter written too late.
      */
      if (object.evoked === true) next = addCounters(next, inst.id, EVOKED, 1);
      /*
        And dash, which is the same read with both consequences arranged on the spot (CR 702.109a).

        Here rather than on the card, which is the difference from evoke: evoke's sacrifice is a
        triggered ability printed on the card, and dash's haste and return are part of **this
        resolution** — nothing goes on the stack for them, so there is no window for an opponent to
        kill the creature between arriving and gaining haste.

        The return is a delayed trigger because that is what the card says it is (CR 603.7): once
        created it stops belonging to the permanent, so a dashed creature that is killed, exiled or
        bounced before the end step leaves the ability behind doing nothing, which is the rule. The
        ability itself lives on the card as its one `delayed` trigger — the arrangement unearth's
        end-step exile already uses — so it gets a resolution path and a description for free.
      */
      if (object.dashed === true) {
        next = addCounters(next, inst.id, DASHED, 1);
        next = pump(next, [inst.id], inst.id, object.controller, { keywords: ['haste'] });
        const index = dashReturnIndex(script);
        if (index >= 0) {
          next = scheduleDelayed(next, {
            source: inst.id,
            controller: object.controller,
            abilityIndex: index,
            step: 'end',
            // `any` rather than `you`: "the next end step" is this turn's, and a creature dashed
            // on somebody else's turn — which flash or a cast trigger could do — goes back at the
            // end of *that* one, which is what the printed card says.
            of: 'any',
            subject: inst.id,
            description: `return ${def?.name ?? 'it'} to its owner's hand`,
          });
        }
      }
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
      /*
        And a bestowed creature, which arrives **attached** rather than as a creature of its own
        (CR 702.103b).

        The same two lines the aura above runs, with the effect read from the bestow declaration
        instead: a card with bestow has two bodies' worth of text, and this is the half that
        applies to somebody else. The `bestowed` flag is already on the card — it was set as the
        spell was announced — so nothing here has to say that this permanent is an Aura; it has
        been one since it went on the stack.
      */
      if (object.bestowed === true && script?.bestow !== undefined) {
        const host = object.targets.find((t) => t.kind === 'card');
        if (host && host.kind === 'card') {
          next = withInstance(next, inst.id, { attachedTo: host.id });
          next = addBestowEffect(next, inst.id, object.controller, host.id, script.bestow.effect);
        }
      }
      // `relocate` above recorded the arrival; `settle` announces it, and `settle` is also where
      // this permanent's own statics are installed — see the arrivals loop there. Applying them
      // here as well was the bug: a permanent that arrived any *other* way got none.

    } else if (inst !== undefined) {
      /*
        Rebound, which is a third destination and a promise (CR 702.88a): the card goes to exile
        rather than to a graveyard, and a delayed trigger for its controller's **next upkeep**
        offers the free cast.

        Here rather than inside `spellLeavesStack` for the reason the adventure branch there gives
        from the other side: this is the only call site that knows the spell resolved, and a
        countered rebound spell goes to the graveyard like any other. And the scheduling has to
        happen where the card's script is in hand anyway — the ability lives on the card, the way
        dash's return and unearth's exile do.

        The index check is the belt: a card with `rebound` and no delayed upkeep trigger would
        otherwise be exiled with nothing to bring it back, which is strictly worse than the card
        not having the keyword. A test holds the pairing; this keeps a mistake in it cheap.
      */
      const reboundAt = object.rebounding === true ? reboundCastIndex(script) : -1;
      if (reboundAt >= 0) {
        next = exileCard(next, inst.id);
        next = scheduleDelayed(next, {
          source: inst.id,
          controller: object.controller,
          abilityIndex: reboundAt,
          step: 'upkeep',
          // `you` rather than `any`: the printed card says *your* next upkeep, so a spell cast on
          // somebody else's turn waits for the caster's own.
          of: 'you',
          subject: inst.id,
          description: `cast ${def?.name ?? 'it'} from exile without paying its mana cost`,
        });
      } else {
        // Graveyard, or exile when it was cast with flashback, or exile on an adventure. The last
        // of the three is the only one that depends on the spell having *resolved*, which is what
        // this call site knows and the other two do not. See `spellLeavesStack`.
        next = spellLeavesStack(next, object, requireInstance(next, inst.id), true);
      }
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
  /** Only a trigger has one. See `TriggerDef.condition`. */
  readonly condition?: ConditionFn;
  readonly decisions?: readonly DecisionSpecOf[];
  readonly beforeDecisions?: EffectFn;
  readonly effect?: EffectFn;
}

function abilityOrTrigger(script: CardScript | undefined, object: StackObject): Resolvable | undefined {
  if (object.abilityIndex === undefined) return undefined;
  /*
    A granted ability is defined on somebody else's card, so the holder's script is the wrong book
    to look it up in (CR 113.6). Asked before the `script === undefined` guard rather than after,
    because the holder may have no script at all — a vanilla Grizzly Bears handed a draw trigger
    by a Tandem Lookout is the normal case, not the exotic one.
  */
  if (object.grantedBy !== undefined) {
    return scriptFor(object.grantedBy.card)?.grantedTriggers?.[object.grantedBy.index];
  }
  if (script === undefined) return undefined;
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

/**
 * The continuous effect a bestowed permanent gives the creature it is attached to.
 *
 * `addAuraEffect`'s twin rather than a parameter on it, because the two read their effect from
 * different declarations — `aura.effect` for a card that is only ever an Aura, `bestow.effect` for
 * one that is an Aura only when it was cast as one. Sharing the scope, the duration and the source
 * is what matters: `removeEffectsFrom` takes this away by source id when the Aura stops being one,
 * and it cannot tell the two apart, which is exactly right.
 */
function addBestowEffect(
  state: GameState, auraId: string, controller: SeatIndex, hostId: string, effect: PumpOptions,
): GameState {
  const seq = state.autoSeq + 1;
  const continuous: ContinuousEffect = {
    id: `fx${seq}`, source: auraId, controller,
    scope: { kind: 'cards', ids: [hostId] },
    duration: 'permanent', createdTurn: state.turn,
    ...modsFrom(effect),
  };
  return { ...state, autoSeq: seq, effects: [...state.effects, continuous] };
}

function applyStatics(
  state: GameState, id: string, controller: SeatIndex, script: CardScript | undefined,
): GameState {
  let next = state;
  for (const entry of script?.statics ?? []) {
    const seq = next.autoSeq + 1;
    const scope: ContinuousEffect['scope'] =
      typeof entry.scope === 'object'
        ? {
            kind: 'controller-subtype', subtype: entry.scope.subtype,
            ...(entry.scope.other === true ? { other: true as const } : {}),
          }
      : entry.scope === 'self' ? { kind: 'cards', ids: [id] }
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
  /*
    And soulbond's, which is a static with one difference: its scope is the **pair**, which is made
    and broken long after this runs. See `ContinuousEffect`'s `pair` scope — the effect sits here
    for the permanent's whole life and reaches nobody while it is unpaired, so there is nothing to
    add when a pair forms and nothing to remove when it breaks.
  */
  if (script?.soulbond !== undefined) {
    const seq = next.autoSeq + 1;
    next = {
      ...next,
      autoSeq: seq,
      effects: [...next.effects, {
        id: `fx${seq}`, source: id, controller, scope: { kind: 'pair' },
        duration: 'permanent', createdTurn: next.turn,
        ...modsFrom(script.soulbond.effect),
      }],
    };
  }
  return next;
}

export { legalTargets, hasAnyLegalTargets, checkTargets, applyStatics, scriptOf, raise, nextAlive, prevAlive, aliveSeats, resetPriority, advanceStep, payFrom, pushAbility, settle, attackAimIssue, canAttack, canBlock, damageOrderChoice, damageOrdersOwed, forcedAttackers, legalAttackers, legalBlockers, legalDefenders, menaceSatisfied, needsFirstStrikeStep, tapAttackers, destroy, STEP_LABELS };
