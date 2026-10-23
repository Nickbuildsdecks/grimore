/**
 * The reducer for automated play: what a player may do, and what happens when they do it.
 *
 * Mirrors `cardActions.ts` — same `Outcome` shape, same place in the dispatch — but where that one
 * asks only "is this move physically coherent", this one asks "is this legal right now": do you
 * hold priority, can you pay for it, is it your main phase, is that a legal target, has that
 * creature got summoning sickness.
 *
 * Every case ends by calling `settle`, which runs state-based actions and raises triggers until the
 * game stops changing. Nothing else in here has to remember that something might have died.
 */
import { zoneKey } from './cards.js';
import { listAt, relocate, requireInstance, withInstance } from './cardActions.js';
import { characteristicsOf } from './characteristics.js';
import {
  advanceStep, aliveSeats, atSorcerySpeed, canAttack, canBlock, checkTargets, endTurnCleanup,
  legalAttackers, legalBlockers, menaceSatisfied, payFrom, pendingDeclaration, prevAlive,
  pushAbility, raise, resetPriority, resolveTop, scriptOf, settle, stackTop, stateBasedActions,
  tapAttackers,
  type AutoAction, type AutoAttackAction, type AutoBlockAction, type AutoCastAction,
} from './automation.js';
import { addToPool, poolOf } from './effects.js';
import { assertSeatIndex, seatName } from './internal.js';
import { canPay, parseManaCost } from './mana.js';
import { scriptFor } from './scripts.js';
import type { CardScript, TargetSpec } from './scriptTypes.js';
import { hasAnyLegalTargets } from './targeting.js';
import { EMPTY_COMBAT, MAIN_STEPS, type CombatAttack, type StackObject, type Target } from './turnTypes.js';
import { EngineError, type ActionContext, type GameState, type Outcome, type SeatIndex } from './types.js';

const requirePriority = (state: GameState, seat: SeatIndex): void => {
  if (state.priority !== seat) throw new EngineError('FORBIDDEN', 'you do not have priority');
};

const requireAutomated = (state: GameState): void => {
  if (!state.automated) throw new EngineError('RULE_NOT_APPLICABLE', 'this table is not running the rules engine');
};

const handOf = (state: GameState, seat: SeatIndex): readonly string[] => listAt(state, zoneKey(seat, 'hand'));

/** The script's targets for a spell, which for an Aura is what it enchants. */
const spellTargets = (script: CardScript | undefined): readonly TargetSpec[] =>
  script?.targets ?? (script?.aura ? [script.aura.target] : []);

// ── Casting ──────────────────────────────────────────────────────────────────────────────────────

function castSpell(state: GameState, action: AutoCastAction): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  const def = state.cardDefs[inst.defKey];
  const script = scriptFor(def?.name);
  const characteristics = characteristicsOf(state, inst);
  if (characteristics.isLand) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'play a land with auto:playLand; lands are not cast');
  }

  // Instants and anything with flash may be cast whenever you hold priority; everything else needs
  // your own main phase with an empty stack.
  const instantSpeed =
    characteristics.typeLine.types.some((t) => t.toLowerCase() === 'instant') ||
    characteristics.keywords.has('flash');
  if (!instantSpeed && !atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} can only be cast in your main phase with an empty stack`);
  }

  const cost = parseManaCost(def?.manaCost);
  if (cost.unsupported !== undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} has a mana cost the engine cannot pay yet`);
  }
  const specs = spellTargets(script);
  const chosen = action.targets ?? [];
  const check = checkTargets(state, specs, chosen, action.by);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  const paid = payFrom(state, action.by, def?.manaCost, action.x ?? 0);
  let next = paid.state;
  // The card physically moves to the stack, and an object describes how it was cast.
  next = relocate(next, requireInstance(next, inst.id), 'stack', action.by, 'bottom');
  const object: StackObject = {
    id: inst.id, kind: 'spell', source: inst.id, controller: action.by,
    cardKey: inst.defKey, targets: [...chosen],
    ...(action.x === undefined ? {} : { x: action.x }),
    description: characteristics.name,
  };
  next = {
    ...next,
    stackObjects: { ...next.stackObjects, [object.id]: object },
    stackOrder: [...next.stackOrder, object.id],
  };
  // Prowess and friends trigger on the cast, which is why this is here and not in `resolveTop`.
  const spellKind = characteristics.isCreature ? 'creature' : 'noncreature';
  next = raise(next, { kind: 'spell-cast', spell: spellKind }, action.by);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    // The lands tapped for it are named, because they turn sideways on screen and a player who
    // did not tap them should be able to see why.
    message: paid.tapped.length === 0
      ? `${seatName(state, action.by)} casts ${characteristics.name}`
      : `${seatName(state, action.by)} taps ${paid.tapped.length} for ${characteristics.name} and casts it`,
    data: { card: inst.id, name: characteristics.name, tapped: [...paid.tapped] },
  };
}

function playLand(state: GameState, action: { by: SeatIndex; card: string }): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  if (!atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'lands can only be played in your main phase with an empty stack');
  }
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  const ch = characteristicsOf(state, inst);
  if (!ch.isLand) throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} is not a land`);
  const played = state.landsPlayed[String(action.by)] ?? 0;
  if (played >= 1) throw new EngineError('RULE_NOT_APPLICABLE', 'you have already played a land this turn');

  let next = relocate(state, inst, 'battlefield', action.by, 'bottom');
  next = { ...next, landsPlayed: { ...next.landsPlayed, [String(action.by)]: played + 1 } };
  next = raise(next, { kind: 'etb' }, action.by, inst.id);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    message: `${seatName(state, action.by)} plays ${ch.name}`,
    data: { card: inst.id, name: ch.name },
  };
}

// ── Activated abilities ──────────────────────────────────────────────────────────────────────────

function activate(
  state: GameState, action: { by: SeatIndex; card: string; abilityIndex: number; targets?: readonly Target[] },
): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'battlefield' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'you do not control that permanent');
  }
  const script = scriptOf(state, inst.id);
  const ability = script?.abilities?.[action.abilityIndex];
  if (ability === undefined) throw new EngineError('RULE_NOT_APPLICABLE', 'that permanent has no such ability');
  const ch = characteristicsOf(state, inst);

  if (ability.sorcerySpeed && !atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that ability can only be activated in your main phase');
  }
  if (ability.cost.tap) {
    if (inst.tapped) throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} is already tapped`);
    // A creature's {T} ability needs it to have been there since the start of the turn, same as
    // attacking (CR 302.6). A non-creature permanent has no such restriction.
    if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} has summoning sickness`);
    }
  }

  const specs = ability.targets ?? [];
  const chosen = action.targets ?? [];
  const check = checkTargets(state, specs, chosen, action.by);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  const paid = payFrom(state, action.by, ability.cost.mana, 0);
  let next = paid.state;
  if (ability.cost.tap) next = withInstance(next, inst.id, { tapped: true });
  if (ability.cost.sacrificeSelf) next = relocate(next, requireInstance(next, inst.id), 'graveyard', inst.owner, 'bottom');

  if (ability.produces !== undefined) {
    // A mana ability resolves immediately and never uses the stack (CR 605.3a) — which is what
    // makes tapping a land in response to something work at all.
    for (const type of ability.produces) next = addToPool(next, action.by, type, 1);
    next = settle(next, state);
    return {
      state: next,
      message: `${seatName(state, action.by)} taps ${ch.name} for ${ability.produces.join('')}`,
      data: { card: inst.id, produced: [...ability.produces] },
    };
  }

  next = pushAbility(next, inst.id, action.by, action.abilityIndex, chosen, 'activated', `${ch.name}: ${ability.description}`);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    message: `${seatName(state, action.by)} activates ${ch.name}`,
    data: { card: inst.id, ability: action.abilityIndex },
  };
}

// ── Priority ─────────────────────────────────────────────────────────────────────────────────────

function pass(state: GameState, action: { by: SeatIndex }): Outcome {
  requireAutomated(state);
  const owed = pendingDeclaration(state);
  if (owed !== null) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${owed.kind} must be declared before anyone passes`);
  }
  requirePriority(state, action.by);
  const passed = state.passed.includes(action.by) ? state.passed : [...state.passed, action.by];
  const everyone = aliveSeats(state);
  const allPassed = everyone.every((seat) => passed.includes(seat));

  if (!allPassed) {
    const nextSeat = everyone.find((s) => !passed.includes(s)) ?? action.by;
    return {
      state: { ...state, passed, priority: nextSeat },
      message: `${seatName(state, action.by)} passes`,
      data: { to: nextSeat },
    };
  }

  // Everybody passed: the top of the stack resolves, or the step ends.
  if (state.stackOrder.length > 0) {
    const before = state;
    const resolved = resolveTop({ ...state, passed: [] });
    const next = resetPriority(settle(resolved.state, before));
    return { state: next, message: resolved.message, data: { resolved: true } };
  }
  const before = state;
  const advanced = advanceStep({ ...state, passed: [] });
  const next = settle(advanced, before);
  return {
    state: next,
    message: `— ${next.step === 'untap' ? `turn ${next.turn}, ${seatName(next, next.activeSeat)}` : stepLabel(next.step)} —`,
    data: { step: next.step, turn: next.turn },
  };
}

const stepLabel = (step: string): string => step.replace(/-/g, ' ');

// ── Combat ───────────────────────────────────────────────────────────────────────────────────────

function declareAttackers(state: GameState, action: AutoAttackAction): Outcome {
  requireAutomated(state);
  if (state.step !== 'declare-attackers') throw new EngineError('RULE_NOT_APPLICABLE', 'it is not the declare attackers step');
  if (state.activeSeat !== action.by) throw new EngineError('FORBIDDEN', 'only the attacking player declares attackers');
  if (state.combat.attackersDeclared) throw new EngineError('RULE_NOT_APPLICABLE', 'attackers have already been declared');

  const seen = new Set<string>();
  const attacks: CombatAttack[] = [];
  for (const entry of action.attackers) {
    if (seen.has(entry.attacker)) throw new EngineError('RULE_NOT_APPLICABLE', 'a creature can only attack once');
    seen.add(entry.attacker);
    const issue = canAttack(state, entry.attacker, action.by);
    if (issue !== null) throw new EngineError('RULE_NOT_APPLICABLE', issue.reason);
    assertSeatIndex(state, entry.defender, 'defender');
    if (entry.defender === action.by) throw new EngineError('RULE_NOT_APPLICABLE', 'you cannot attack yourself');
    attacks.push({ attacker: entry.attacker, defender: entry.defender, blockers: [] });
  }

  let next: GameState = {
    ...state,
    combat: { attacks, firstStrikeDealt: false, attackersDeclared: true, blockersDeclaredBy: [] },
  };
  next = tapAttackers(next, next.combat);
  for (const attack of attacks) next = raise(next, { kind: 'attacks' }, action.by, attack.attacker);
  next = resetPriority(settle(next, state));
  return {
    state: next,
    message: attacks.length === 0
      ? `${seatName(state, action.by)} attacks with nothing`
      : `${seatName(state, action.by)} attacks with ${attacks.length} creature(s)`,
    data: { attackers: attacks.map((a) => a.attacker) },
  };
}

function declareBlockers(state: GameState, action: AutoBlockAction): Outcome {
  requireAutomated(state);
  if (state.step !== 'declare-blockers') throw new EngineError('RULE_NOT_APPLICABLE', 'it is not the declare blockers step');
  if (state.activeSeat === action.by) throw new EngineError('FORBIDDEN', 'the attacking player does not block');
  if (state.combat.blockersDeclaredBy.includes(action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'you have already declared blockers');
  }
  if (!state.combat.attacks.some((a) => a.defender === action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'nothing is attacking you');
  }

  const assigned = new Map<string, string[]>();
  const used = new Set<string>();
  for (const entry of action.blocks) {
    if (used.has(entry.blocker)) throw new EngineError('RULE_NOT_APPLICABLE', 'a creature can only block one attacker');
    const attack = state.combat.attacks.find((a) => a.attacker === entry.attacker);
    if (attack === undefined) throw new EngineError('RULE_NOT_APPLICABLE', 'that creature is not attacking');
    if (attack.defender !== action.by) throw new EngineError('RULE_NOT_APPLICABLE', 'that attack is not aimed at you');
    const issue = canBlock(state, entry.blocker, entry.attacker, action.by);
    if (issue !== null) throw new EngineError('RULE_NOT_APPLICABLE', issue.reason);
    used.add(entry.blocker);
    assigned.set(entry.attacker, [...(assigned.get(entry.attacker) ?? []), entry.blocker]);
  }

  // Only this seat's own attacks are rewritten: in a pod another defender may have blocked already,
  // and replacing every attack's blockers would throw their declaration away.
  const attacks = state.combat.attacks.map((a) =>
    a.defender === action.by ? { ...a, blockers: assigned.get(a.attacker) ?? [] } : a,
  );
  for (const attack of attacks) {
    if (attack.defender !== action.by) continue;
    if (!menaceSatisfied({ ...state, combat: { ...state.combat, attacks } }, attack)) {
      const name = characteristicsOf(state, requireInstance(state, attack.attacker)).name;
      throw new EngineError('RULE_NOT_APPLICABLE', `${name} has menace and must be blocked by two or more creatures`);
    }
  }

  let next: GameState = {
    ...state,
    combat: { ...state.combat, attacks, blockersDeclaredBy: [...state.combat.blockersDeclaredBy, action.by] },
  };
  // Priority only returns once every defender has declared.
  next = pendingDeclaration(next) === null ? resetPriority(settle(next, state)) : settle(next, state);
  const blocking = attacks.reduce((n, a) => n + (a.defender === action.by ? a.blockers.length : 0), 0);
  return {
    state: next,
    message: blocking === 0
      ? `${seatName(state, action.by)} does not block`
      : `${seatName(state, action.by)} blocks with ${blocking} creature(s)`,
    data: { blockers: blocking },
  };
}

// ── Discarding to hand size ──────────────────────────────────────────────────────────────────────

function discard(state: GameState, action: { by: SeatIndex; card: string }): Outcome {
  requireAutomated(state);
  const pending = state.pendingDiscard;
  if (pending === null) throw new EngineError('RULE_NOT_APPLICABLE', 'nothing to discard');
  if (pending.seat !== action.by) throw new EngineError('FORBIDDEN', 'it is not your discard');
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  const name = characteristicsOf(state, inst).name;
  let next = relocate(state, inst, 'graveyard', inst.owner, 'bottom');
  const left = pending.count - 1;
  next = { ...next, pendingDiscard: left > 0 ? { seat: pending.seat, count: left } : null };
  if (left === 0) {
    // The cleanup step finishes and the turn ends.
    next = endTurnCleanup(next);
    next = advanceStep(next);
  }
  next = settle(next, state);
  return {
    state: next,
    message: `${seatName(state, action.by)} discards ${name}`,
    data: { card: inst.id, remaining: left },
  };
}

// ── Starting ─────────────────────────────────────────────────────────────────────────────────────

function startAutomation(state: GameState, action: { by: SeatIndex; firstSeat?: SeatIndex }): Outcome {
  if (state.automated) throw new EngineError('ALREADY_STARTED', 'the rules engine is already running');
  if (!state.started) throw new EngineError('NOT_STARTED', 'deal the table first');
  const first = action.firstSeat ?? state.activeSeat;
  assertSeatIndex(state, first, 'firstSeat');
  let next: GameState = {
    ...state,
    automated: true,
    activeSeat: first,
    step: 'untap',
    combat: EMPTY_COMBAT,
    pools: {},
    landsPlayed: {},
    passed: [],
    priority: null,
  };
  // Walk into the first step that gives somebody priority, doing untap and upkeep on the way.
  // Entering from the cleanup step is what runs the start-of-turn actions, and that roll advances
  // the active seat — so it starts from the seat *before* `first`, or `first` never gets its turn.
  next = advanceStep({ ...next, step: 'cleanup', turn: state.turn - 1, activeSeat: prevAlive(next, first) });
  next = settle(next, state);
  return {
    state: next,
    message: `the rules engine takes over; ${seatName(next, next.activeSeat)} begins turn ${next.turn}`,
    data: { step: next.step, turn: next.turn },
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────────

export function reduceAutoAction(state: GameState, action: AutoAction, _ctx: ActionContext): Outcome {
  switch (action.type) {
    case 'auto:start': return startAutomation(state, action);
    case 'auto:playLand': return playLand(state, action);
    case 'auto:cast': return castSpell(state, action);
    case 'auto:activate': return activate(state, action);
    case 'auto:pass': return pass(state, action);
    case 'auto:attack': return declareAttackers(state, action);
    case 'auto:block': return declareBlockers(state, action);
    case 'auto:discard': return discard(state, action);
    default: {
      const exhaustive: never = action;
      throw new EngineError('INVALID_ACTION', `unknown action: ${String((exhaustive as { type?: string }).type)}`);
    }
  }
}

export { canPay, hasAnyLegalTargets, MAIN_STEPS, pendingDeclaration, stackTop, stateBasedActions, legalAttackers, legalBlockers, poolOf, handOf, spellTargets };
