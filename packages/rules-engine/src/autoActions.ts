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
import { characteristicsOf, hasType } from './characteristics.js';
import {
  advanceStep, aliveSeats, applyStatics, atSorcerySpeed, attackAimIssue, autoPassFor, bottomOwed,
  canAttack, canBlock, checkTargets, damageOrdersOwed, endTurnCleanup, forcedAttackers, legalAttackers,
  legalBlockers, menaceSatisfied, payFrom, pendingDeclaration,
  answerDecision, modeCombinations, modeTargetSpecs, modesOf, prevAlive, pushAbility, raise,
  resetPriority, resolveTop, sacrificeOptions, scriptOf, settle, stackTop, stateBasedActions,
  stillDeciding, tapAttackers,
  type AutoAction, type AutoAttackAction, type AutoBlockAction, type AutoCastAction,
  type AutoOrderAction,
} from './automation.js';
import { addToPool, loseLife, poolOf } from './effects.js';
import { assertSeatIndex, replaceSeat, seatName } from './internal.js';
import { canPay, parseManaCost } from './mana.js';
import { scriptFor } from './scripts.js';
import type { CardScript, TargetSpec } from './scriptTypes.js';
import { hasAnyLegalTargets, targetSeqsFor } from './targeting.js';
import { legalActions } from './legalActions.js';
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
  // A commander is cast from the command zone (CR 903.8); everything else from hand.
  const fromCommand = inst.zone === 'command' && inst.isCommander;
  if (!fromCommand && (inst.zone !== 'hand' || inst.zoneSeat !== action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  if (fromCommand && inst.zoneSeat !== action.by) {
    throw new EngineError('FORBIDDEN', 'that is not your commander');
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
  // A modal spell's modes are announced as it is cast (CR 601.2b), before its targets, and the
  // modes decide what it may point at — so they are validated first and the target specs come
  // from them. A combination the card does not offer is refused rather than trimmed.
  const combinations = modeCombinations(script);
  let modes: readonly number[] | undefined;
  if (combinations.length > 0) {
    const asked = [...(action.modes ?? [])].sort((a, b) => a - b);
    const legal = combinations.some((c) => c.length === asked.length && c.every((i, n) => i === asked[n]));
    if (!legal) {
      throw new EngineError('RULE_NOT_APPLICABLE',
        action.modes === undefined
          ? `choose a mode for ${characteristics.name}`
          : 'that is not a combination of modes this spell offers');
    }
    modes = asked;
  } else if (action.modes !== undefined && action.modes.length > 0) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} has no modes to choose`);
  }

  // X is announced with the spell (CR 601.2b), so it arrives with the action rather than being
  // asked for on resolution. Refused rather than ignored when the cost has no {X} in it: a client
  // sending one has misunderstood the card, and silently dropping it would put an x on the stack
  // object that an effect could read.
  const printedCost = parseManaCost(def?.manaCost);
  if (action.x !== undefined) {
    if (!printedCost.x) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} has no X to choose`);
    }
    if (!Number.isInteger(action.x) || action.x < 0) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'X must be a whole number, and cannot be negative');
    }
  }

  // The kicker is announced with the spell (CR 702.32a), so it arrives on the action like X and
  // the modes do. Refused on a card without one rather than ignored: a client sending it has
  // misread the card, and silently dropping it would put a `kicked` on the stack object that the
  // card's own effect reads.
  const kicked = action.kicked === true;
  if (kicked && script?.kicker === undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} has no kicker`);
  }

  const specs = modes === undefined ? spellTargets(script) : modeTargetSpecs(modesOf(script, modes));
  const chosen = action.targets ?? [];
  const check = checkTargets(state, specs, chosen, action.by, inst.id);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  /*
    An additional cost that is not optional, chosen and checked before anything is spent.

    A cost, not a target: it is paid as the spell is cast, so the creature is in the graveyard
    before anybody may respond and cannot be saved in reply. And a spell whose additional cost
    cannot be paid is not castable at all (CR 601.2h) — "you have no creature to sacrifice" rather
    than a spell that sits on the stack waiting for one.
  */
  let sacrificed: string | null = null;
  let sacrificedName = '';
  if (script?.additionalCost !== undefined) {
    const options = sacrificeOptions(state, action.by, inst.id, { sacrifice: script.additionalCost.sacrifice });
    if (options.length === 0) {
      throw new EngineError('RULE_NOT_APPLICABLE', `you have no creature to sacrifice for ${characteristics.name}`);
    }
    if (action.sacrifice === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE', `choose a creature to sacrifice for ${characteristics.name}`);
    }
    if (!options.includes(action.sacrifice)) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that creature cannot be sacrificed for this');
    }
    sacrificed = action.sacrifice;
  } else if (action.sacrifice !== undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${characteristics.name} has no additional cost to pay`);
  }

  // The tax is generic mana on top of the printed cost, and it only applies to a cast from the
  // command zone. It goes up by two *after* the cast, so the first one is free of it.
  const tax = fromCommand ? (state.seats[action.by]?.commanderTax ?? 0) : 0;
  // The kicker is paid as part of the spell's total cost, so it goes to `payFrom` as more symbols
  // on the same cost rather than as a second payment: a kicked spell either gets cast or does not,
  // and a player who could pay the printed cost but not the kicker must not end up having paid
  // half of it.
  const costText = kicked ? `${def?.manaCost ?? ''}${script?.kicker?.cost ?? ''}` : def?.manaCost;
  const paid = payFrom(state, action.by, costText, action.x ?? 0, tax);
  let next = paid.state;
  if (sacrificed !== null) {
    const victim = requireInstance(next, sacrificed);
    sacrificedName = characteristicsOf(next, victim).name;
    // It dies now, as the cost is paid — not when the spell resolves. `relocate` records the
    // death and `settle` raises it, which also puts a death trigger on the stack *above* the
    // spell that paid for it, so the trigger resolves first (CR 603.3b).
    next = relocate(next, victim, 'graveyard', victim.owner, 'bottom');
  }
  if (fromCommand) {
    next = replaceSeat(next, action.by, { commanderTax: tax + 2 });
  }
  // The card physically moves to the stack, and an object describes how it was cast.
  next = relocate(next, requireInstance(next, inst.id), 'stack', action.by, 'bottom');
  // The modes are named in the stack description, because both players can see what was chosen
  // and the one deciding whether to respond needs to know which half of the Charm is coming.
  const modeText = modes === undefined
    ? ''
    : ` — ${modesOf(script, modes).map((m) => m.description).join('; and ')}`;
  // X is in the description for the same reason the modes are: the player deciding whether to
  // respond has to know how big the Fireball is, and the stack is where both players read it.
  const xText = printedCost.x ? ` (X=${action.x ?? 0})` : '';
  // And the kicker, for the same reason again: whether it was paid changes what the spell does,
  // and the player deciding whether to respond reads the stack to find out.
  const kickedText = kicked ? ' (kicked)' : '';
  const object: StackObject = {
    id: inst.id, kind: 'spell', source: inst.id, controller: action.by,
    cardKey: inst.defKey, targets: [...chosen], targetSeqs: targetSeqsFor(state, chosen),
    ...(action.x === undefined ? {} : { x: action.x }),
    ...(modes === undefined ? {} : { modes: [...modes] }),
    ...(kicked ? { kicked: true } : {}),
    description: `${characteristics.name}${xText}${kickedText}${modeText}`,
  };
  next = {
    ...next,
    stackObjects: { ...next.stackObjects, [object.id]: object },
    stackOrder: [...next.stackOrder, object.id],
  };
  // Prowess and friends trigger on the cast, which is why this is here and not in `resolveTop`.
  const spellKind = characteristics.isCreature ? 'creature' : 'noncreature';
  next = raise(next, {
    kind: 'spell-cast',
    spell: spellKind,
    types: characteristics.typeLine.types.map((t) => t.toLowerCase()),
  }, action.by);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    // The lands tapped for it are named, because they turn sideways on screen and a player who
    // did not tap them should be able to see why.
    message: paid.tapped.length === 0
      ? `${seatName(state, action.by)} casts ${characteristics.name}${kickedText}${tax > 0 ? ` (+{${tax}} tax)` : ''}`
      : `${seatName(state, action.by)} taps ${paid.tapped.length} for ${characteristics.name}${kickedText} and casts it`,
    data: {
      card: inst.id, name: characteristics.name, tapped: [...paid.tapped],
      ...(kicked ? { kicked: true } : {}),
      ...(sacrificed === null ? {} : { sacrificed, sacrificedName }),
    },
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
  state: GameState,
  action: {
    by: SeatIndex; card: string; abilityIndex: number;
    targets?: readonly Target[]; sacrifice?: string;
  },
): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  const inst = requireInstance(state, action.card);
  const script = scriptOf(state, inst.id);
  const ability = script?.abilities?.[action.abilityIndex];
  /*
    Which zone this ability is used from, decided by its cost.

    An ability that pays for itself by being discarded — cycling (CR 702.29a) — is used from the
    hand, and every other ability in the pool is used from the battlefield. The cost says which, so
    a script never has to: the alternative was a `fromHand` flag that could disagree with the cost
    beside it, and the same reasoning already decides sorcery speed for a loyalty ability.
  */
  const fromHand = ability?.cost.discardSelf === true;
  const wantedZone = fromHand ? 'hand' : 'battlefield';
  if (inst.zone !== wantedZone || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE',
      fromHand ? 'that card is not in your hand' : 'you do not control that permanent');
  }
  if (ability === undefined) throw new EngineError('RULE_NOT_APPLICABLE', 'that permanent has no such ability');
  const ch = characteristicsOf(state, inst);

  if (ability.sorcerySpeed && !atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that ability can only be activated in your main phase');
  }
  // A loyalty ability carries three restrictions with it, all from CR 606: sorcery speed, one
  // per planeswalker per turn, and a minus you can actually pay for. Checked here as well as in
  // `legalActions` because an action can arrive from anywhere, and the third one is the rule that
  // decides whether a planeswalker survives its own ability.
  if (ability.cost.loyalty !== undefined) {
    if (!atSorcerySpeed(state, action.by)) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'a loyalty ability is a sorcery-speed action');
    }
    if (inst.loyaltyUsedTurn === state.turn) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} has already used a loyalty ability this turn`);
    }
    if ((inst.counters['loyalty'] ?? 0) + ability.cost.loyalty < 0) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} does not have the loyalty for that`);
    }
  }
  if (ability.cost.tap) {
    if (inst.tapped) throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} is already tapped`);
    // A creature's {T} ability needs it to have been there since the start of the turn, same as
    // attacking (CR 302.6). A non-creature permanent has no such restriction.
    if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${ch.name} has summoning sickness`);
    }
  }

  if (ability.cost.life !== undefined) {
    // Checked before anything is spent, and refused at exactly the life that would kill you: a
    // cost you cannot pay is not a cost you may choose to pay (CR 118.4).
    const life = state.seats[action.by]?.life ?? 0;
    if (life <= ability.cost.life) {
      throw new EngineError('RULE_NOT_APPLICABLE', `you do not have ${ability.cost.life} life to pay`);
    }
  }

  const specs = ability.targets ?? [];
  const chosen = action.targets ?? [];
  const check = checkTargets(state, specs, chosen, action.by, inst.id);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  // The sacrifice is chosen and checked before anything is spent, so a refusal leaves the board
  // exactly as it was rather than halfway through paying.
  let sacrificed: string | null = null;
  let sacrificedName = '';
  if (ability.cost.sacrifice !== undefined) {
    const options = sacrificeOptions(state, action.by, inst.id, ability.cost);
    if (options.length === 0) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'you have no creature to sacrifice for that');
    }
    if (action.sacrifice === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'choose a creature to sacrifice');
    }
    if (!options.includes(action.sacrifice)) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that creature cannot be sacrificed for this');
    }
    sacrificed = action.sacrifice;
  }

  const paid = payFrom(state, action.by, ability.cost.mana, 0);
  let next = paid.state;
  if (ability.cost.life !== undefined) next = loseLife(next, action.by, ability.cost.life);
  if (ability.cost.tap) next = withInstance(next, inst.id, { tapped: true });
  if (ability.cost.loyalty !== undefined) {
    // Paid as the ability is activated (CR 606.2), so the counters move before it is on the
    // stack: a planeswalker that goes to zero this way is already dying while its own ability
    // waits to resolve, and the ability still resolves — which is the rule, and the reason the
    // cost is not paid on resolution.
    const current = requireInstance(next, inst.id).counters['loyalty'] ?? 0;
    next = withInstance(next, inst.id, {
      counters: { ...requireInstance(next, inst.id).counters, loyalty: current + ability.cost.loyalty },
      loyaltyUsedTurn: state.turn,
    });
  }
  if (sacrificed !== null) {
    const victim = requireInstance(next, sacrificed);
    const name = characteristicsOf(next, victim).name;
    // A sacrificed creature dies, and anything that cares about that cares now — not when the
    // ability resolves, because the cost was paid before it was ever on the stack. `relocate`
    // records it and `settle` announces it, which also gets the ordering right: the death trigger
    // goes on the stack above the ability and resolves before it (CR 603.3b).
    next = relocate(next, victim, 'graveyard', victim.owner, 'bottom');
    sacrificedName = name;
  }
  if (ability.cost.sacrificeSelf) next = relocate(next, requireInstance(next, inst.id), 'graveyard', inst.owner, 'bottom');
  // Discarded as the cost is paid, so the card is in the graveyard while its own ability is still
  // on the stack (CR 702.29a) — which is why a cycling land can be cycled and then returned from
  // the graveyard by something else before the draw has even happened.
  if (ability.cost.discardSelf) next = relocate(next, requireInstance(next, inst.id), 'graveyard', inst.owner, 'bottom');

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
    message: sacrificed === null
      ? `${seatName(state, action.by)} activates ${ch.name}`
      : `${seatName(state, action.by)} sacrifices ${sacrificedName} and activates ${ch.name}`,
    data: {
      card: inst.id, ability: action.abilityIndex,
      ...(sacrificed === null ? {} : { sacrificed }),
    },
  };
}

// ── Priority ─────────────────────────────────────────────────────────────────────────────────────

function pass(state: GameState, action: { by: SeatIndex }): Outcome {
  requireAutomated(state);
  if (state.pendingChoice !== null) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${state.pendingChoice.description} needs a target first`);
  }
  if (state.pendingDecision !== null) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${state.pendingDecision.prompt} must be answered first`);
  }
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
    // A resolution that stopped to ask a question is not over, and nobody gets priority back in
    // the middle of one — the spell is still on the stack and the answer continues it.
    const suspended = resolved.state.pendingDecision !== null;
    const next = suspended ? settle(resolved.state, before) : resetPriority(settle(resolved.state, before));
    return { state: next, message: resolved.message, data: { resolved: !suspended } };
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

/** A card's printed name, by instance id, for the log lines that have to say what fought what. */
const cardName = (state: GameState, id: string): string => {
  const inst = state.instances[id];
  return inst === undefined ? 'a creature' : state.cardDefs[inst.defKey]?.name ?? 'a creature';
};

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
    // Goad: the creature has to attack, and it has to attack somebody else (CR 701.38a). Checked
    // per attack rather than with the requirement below, because this one is about the aim.
    const aim = attackAimIssue(state, entry.attacker, action.by, entry.defender);
    if (aim !== null) throw new EngineError('RULE_NOT_APPLICABLE', aim.reason);
    // A planeswalker is attacked instead of its controller (CR 506.2), so the seat still says
    // who declares blockers and the planeswalker says where the damage goes. It has to be a
    // planeswalker, and it has to be *theirs* — attacking your own is not a thing, and nor is
    // naming one that is not on the battlefield.
    if (entry.planeswalker !== undefined) {
      const walker = state.instances[entry.planeswalker];
      const ok = walker !== undefined && walker.zone === 'battlefield' && walker.zoneSeat === entry.defender
        && hasType(characteristicsOf(state, walker).typeLine, 'planeswalker');
      if (!ok) throw new EngineError('RULE_NOT_APPLICABLE', 'that is not a planeswalker you can attack');
    }
    attacks.push({
      attacker: entry.attacker, defender: entry.defender, blockers: [],
      attackerSeq: state.instances[entry.attacker]?.objectSeq ?? 0,
      ...(entry.planeswalker === undefined ? {} : { planeswalker: entry.planeswalker }),
    });
  }

  /*
    And whatever had to go, went (CR 508.1d).

    Checked after the declaration is built rather than per creature, because that is the shape of
    the rule: a requirement is about the list, not about the card. A creature that could not have
    attacked — tapped, summoning-sick, Pacified — is not in `forcedAttackers` at all, and in a pod
    with nobody left to attack neither is anything else.
  */
  const owed = forcedAttackers(state, action.by).filter((id) => !seen.has(id));
  if (owed.length > 0 && state.seats.some((s) => s.index !== action.by && !s.eliminated)) {
    throw new EngineError(
      'RULE_NOT_APPLICABLE',
      `${cardName(state, owed[0]!)} attacks each combat if able`,
    );
  }

  let next: GameState = {
    ...state,
    combat: {
      attacks, firstStrikeDealt: false, attackersDeclared: true, blockersDeclaredBy: [],
      damageOrdered: false,
    },
  };
  next = tapAttackers(next, next.combat);
  /*
    One event per attack, carrying who declared it and what it is aimed at.

    What it is aimed at travels on the event because the trigger that wants it — "whenever a
    creature you control attacks, deal 1 damage to the player or planeswalker it's attacking" —
    resolves *after* the declaration, by which time the creature may be dead and the attack gone
    from combat. Looking it up then would be reading a board that no longer says so.
  */
  for (const attack of attacks) {
    next = raise(
      next,
      {
        kind: 'attacks',
        subjectSeat: action.by,
        attacked: {
          defender: attack.defender,
          ...(attack.planeswalker === undefined ? {} : { planeswalker: attack.planeswalker }),
        },
      },
      action.by,
      attack.attacker,
    );
  }
  next = resetPriority(settle(next, state));
  return {
    state: next,
    // Named, and aimed. "Attacks with 2 creature(s)" is true and useless: in a pod the question
    // a reader has is who is being attacked, and in a duel it is what with.
    message: attacks.length === 0
      ? `${seatName(state, action.by)} attacks with nothing`
      : `${seatName(state, action.by)} attacks: ${attacks
          .map((a) => `${cardName(state, a.attacker)} at ${a.planeswalker === undefined
            ? seatName(state, a.defender)
            : cardName(state, a.planeswalker)}`)
          .join(', ')}`,
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
  const attacks = state.combat.attacks.map((a) => {
    if (a.defender !== action.by) return a;
    const blockers = assigned.get(a.attacker) ?? [];
    const blockerSeqs: Record<string, number> = {};
    for (const id of blockers) blockerSeqs[id] = state.instances[id]?.objectSeq ?? 0;
    return { ...a, blockers, ...(blockers.length === 0 ? {} : { blockerSeqs }) };
  });
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
      : `${seatName(state, action.by)} blocks: ${attacks
          .filter((a) => a.defender === action.by && a.blockers.length > 0)
          .map((a) => `${a.blockers.map((b) => cardName(state, b)).join(' and ')} on ${cardName(state, a.attacker)}`)
          .join(', ')}`,
    data: { blockers: blocking },
  };
}

/**
 * The attacking player's damage assignment order (CR 509.2).
 *
 * Rewrites each attack's `blockers` into the order given, which is the order `dealCombatDamage`
 * already spends the attacker's power in — so the rule needed no new code in the damage step, only
 * somebody to ask. Before this the order was the order the blocks were *declared* in, which is the
 * defending player's: measured over 160 four-seat pods, 276 attacks were blocked by two or more
 * creatures, the order changed which of them died in 54, and in 32 of those the defender's order
 * cost the attacker a kill it could have had.
 *
 * Every owed order must be answered in the one action, and only the owed ones: an order for an
 * attack that did not need one is a client that has worked something out for itself, which is the
 * kind of disagreement `legalActions` exists to prevent.
 */
function orderDamage(state: GameState, action: AutoOrderAction): Outcome {
  requireAutomated(state);
  if (state.step !== 'declare-blockers') throw new EngineError('RULE_NOT_APPLICABLE', 'it is not the declare blockers step');
  if (state.activeSeat !== action.by) throw new EngineError('FORBIDDEN', 'only the attacking player orders the blockers');
  if (state.combat.damageOrdered) throw new EngineError('RULE_NOT_APPLICABLE', 'the damage order has already been set');
  const owed = damageOrdersOwed(state, action.by);
  if (owed.length === 0) throw new EngineError('RULE_NOT_APPLICABLE', 'no attack needs a damage order');

  const given = new Map(action.orders.map((entry) => [entry.attacker, entry.blockers]));
  if (given.size !== action.orders.length) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'one order per attacking creature');
  }
  for (const entry of owed) {
    const order = given.get(entry.attacker);
    if (order === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${cardName(state, entry.attacker)} still needs a damage order`);
    }
    // The same blockers, rearranged — not a different set, and not a short list that would leave
    // a blocker out of the damage it is owed.
    const want = [...entry.blockers].sort();
    const got = [...order].sort();
    if (want.length !== got.length || want.some((id, i) => id !== got[i])) {
      throw new EngineError('RULE_NOT_APPLICABLE', `that is not the creatures blocking ${cardName(state, entry.attacker)}`);
    }
  }
  for (const attacker of given.keys()) {
    if (!owed.some((entry) => entry.attacker === attacker)) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${cardName(state, attacker)} does not need a damage order`);
    }
  }

  const attacks = state.combat.attacks.map((attack) => {
    const order = given.get(attack.attacker);
    if (order === undefined) return attack;
    // Anything that has left combat keeps its place in the list: `dealCombatDamage` filters the
    // dead out itself, and dropping them here would lose the order if one came back.
    const rest = attack.blockers.filter((id) => !order.includes(id));
    return { ...attack, blockers: [...order, ...rest] };
  });
  const next = resetPriority(settle({
    ...state,
    combat: { ...state.combat, attacks, damageOrdered: true },
  }, state));
  return {
    state: next,
    message: `${seatName(state, action.by)} assigns damage: ${owed
      .map((entry) => {
        const order = given.get(entry.attacker) ?? entry.blockers;
        return `${cardName(state, entry.attacker)} to ${order.map((id) => cardName(state, id)).join(', then ')}`;
      })
      .join('; ')}`,
    data: { ordered: owed.length },
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

// ── Opening hands ────────────────────────────────────────────────────────────────────────────────

/**
 * Settles on an opening hand, putting back one card for each mulligan taken.
 *
 * Which cards go back is a real decision and one of the most consequential in a game of Magic, so
 * the engine will not choose. A seat that never mulliganed owes nothing and keeps by sending this
 * with no cards — the point of doing that rather than nothing at all is that `auto:start` can then
 * tell "ready to play" from "still deciding".
 */
function keepHand(state: GameState, action: { by: SeatIndex; bottom?: readonly string[] }): Outcome {
  if (!state.started) throw new EngineError('NOT_STARTED', 'deal the table first');
  if (state.automated && !state.openingHands) throw new EngineError('ALREADY_STARTED', 'the game has already begun');
  const owed = bottomOwed(state, action.by);
  const chosen = action.bottom ?? [];
  if (chosen.length !== owed) {
    throw new EngineError('RULE_NOT_APPLICABLE',
      owed === 0
        ? 'you have not mulliganed, so nothing goes back'
        : `put exactly ${owed} card${owed === 1 ? '' : 's'} on the bottom`);
  }
  const seen = new Set<string>();
  let next = state;
  for (const id of chosen) {
    if (seen.has(id)) throw new EngineError('RULE_NOT_APPLICABLE', 'the same card cannot go back twice');
    seen.add(id);
    const inst = requireInstance(next, id);
    if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
    }
    next = relocate(next, inst, 'library', action.by, 'bottom');
  }
  next = { ...next, kept: next.kept.includes(action.by) ? next.kept : [...next.kept, action.by] };
  const kept = owed === 0
    ? `${seatName(state, action.by)} keeps`
    : `${seatName(state, action.by)} keeps ${handOf(next, action.by).length} and puts ${owed} on the bottom`;

  // The last player to settle starts the game.
  if (next.openingHands && stillDeciding(next).length === 0) {
    next = beginFirstTurn(next);
    return {
      state: next,
      message: `${kept} — ${seatName(next, next.activeSeat)} begins turn ${next.turn}`,
      data: { seat: action.by, bottom: owed, step: next.step, turn: next.turn },
    };
  }
  return { state: next, message: kept, data: { seat: action.by, bottom: owed } };
}

/**
 * Walks into the first step that gives somebody priority, doing untap and upkeep on the way.
 *
 * Entering from the cleanup step is what runs the start-of-turn actions, and that roll advances
 * the active seat — so it starts from the seat *before* the first player, or the first player
 * never gets their turn.
 */
function beginFirstTurn(state: GameState): GameState {
  const first = state.activeSeat;
  let next = advanceStep({
    ...state, openingHands: false, step: 'cleanup', turn: state.turn - 1,
    activeSeat: prevAlive(state, first),
  });
  return settle(next, state);
}

// ── Choosing a trigger's targets ─────────────────────────────────────────────────────────────────

/** The specs a stack object's ability wants targets for. */
function specsForObject(state: GameState, object: StackObject): readonly TargetSpec[] {
  const script = scriptFor(state.cardDefs[object.cardKey]?.name);
  if (object.abilityIndex === undefined) return [];
  return (object.kind === 'activated'
    ? script?.abilities?.[object.abilityIndex]?.targets
    : script?.triggers?.[object.abilityIndex]?.targets) ?? [];
}

/**
 * Answers a triggered ability's request for targets.
 *
 * Checked with the same `checkTargets` a spell goes through, so a trigger cannot be pointed at
 * something a spell could not be — and once it is answered, play carries on from exactly where it
 * stopped, with the active player holding priority.
 */
function chooseTargets(state: GameState, action: { by: SeatIndex; targets: readonly Target[] }): Outcome {
  requireAutomated(state);
  const pending = state.pendingChoice;
  if (pending === null) throw new EngineError('RULE_NOT_APPLICABLE', 'nothing is waiting for a choice');
  if (pending.seat !== action.by) throw new EngineError('FORBIDDEN', 'it is not your choice to make');
  const object = state.stackObjects[pending.stackId];
  if (object === undefined) throw new EngineError('RULE_NOT_APPLICABLE', 'that ability is no longer on the stack');

  const specs = specsForObject(state, object);
  const check = checkTargets(state, specs, action.targets, action.by, object.source);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  let next: GameState = {
    ...state,
    stackObjects: {
      ...state.stackObjects,
      [object.id]: {
        ...object,
        targets: [...action.targets],
        targetSeqs: targetSeqsFor(state, action.targets),
      },
    },
    pendingChoice: null,
  };
  next = resetPriority(settle(next, state));
  return {
    state: next,
    message: `${seatName(state, action.by)} aims ${object.description}`,
    data: { ability: object.id, targets: action.targets.length },
  };
}

// ── Answering a question a card asked while resolving ────────────────────────────────────────────

/**
 * Answers a card's mid-resolution question, and lets the resolution carry on.
 *
 * The whole validation is here rather than split with the engine, because every one of these is a
 * way a client could otherwise reach into a hidden zone: a library search hands the chooser a list
 * of candidates, and accepting an id that is not on that list would let a crafted action fetch any
 * card from any library. So the id must be one the engine itself offered, for this question, and
 * the count must be what the card asked for.
 */
function decide(state: GameState, action: { by: SeatIndex; cards?: readonly string[] }): Outcome {
  requireAutomated(state);
  const pending = state.pendingDecision;
  if (pending === null) throw new EngineError('RULE_NOT_APPLICABLE', 'nothing is waiting on a decision');
  if (pending.seat !== action.by) throw new EngineError('FORBIDDEN', 'it is not your decision to make');
  const chosen = action.cards ?? [];
  if (chosen.length < pending.min || chosen.length > pending.max) {
    throw new EngineError('RULE_NOT_APPLICABLE', pending.min === pending.max
      ? `choose exactly ${pending.min}`
      : `choose between ${pending.min} and ${pending.max}`);
  }
  const seen = new Set<string>();
  for (const id of chosen) {
    if (seen.has(id)) throw new EngineError('RULE_NOT_APPLICABLE', 'the same card cannot be chosen twice');
    seen.add(id);
    if (!pending.candidates.includes(id)) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not one of the choices');
    }
  }
  const names = chosen.map((id) => characteristicsOf(state, requireInstance(state, id)).name);
  const resumed = answerDecision(state, chosen);
  // Priority returns only once the resolution is actually over; a resolution that stopped to ask
  // somebody else something is still resolving, and nobody may act in the middle of it.
  const next = resumed.state.pendingDecision === null
    ? resetPriority(settle(resumed.state, state))
    : settle(resumed.state, state);
  return {
    state: next,
    message: names.length === 0
      ? `${seatName(state, action.by)} chooses nothing — ${resumed.message}`
      : `${seatName(state, action.by)} chooses ${names.join(', ')} — ${resumed.message}`,
    data: { cards: [...chosen], resolved: next.pendingDecision === null },
  };
}

// ── Starting ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One seat's stops setting, and nobody else's.
 *
 * `autoPassOff` is a list for this reason: it was one boolean, so a player asking to see every step
 * made the engine stop for *both* players — and the one who never touched the setting was then
 * asked twenty-five times a turn whether they still had nothing to do. How you want to be asked is
 * a preference, not a rule about the game.
 */
function setStops(state: GameState, action: { by: SeatIndex; autoPass: boolean }): Outcome {
  requireAutomated(state);
  assertSeatIndex(state, action.by, 'by');
  const off = (state.autoPassOff ?? []).filter((seat) => seat !== action.by);
  return {
    state: { ...state, autoPassOff: action.autoPass ? off : [...off, action.by] },
    message: action.autoPass
      ? `${seatName(state, action.by)} lets the table pass for them when there is nothing to do`
      : `${seatName(state, action.by)} asks to be offered every priority`,
    data: { autoPass: action.autoPass, seat: action.by },
  };
}

function startAutomation(
  state: GameState, action: { by: SeatIndex; firstSeat?: SeatIndex; autoPass?: boolean },
): Outcome {
  if (state.automated) throw new EngineError('ALREADY_STARTED', 'the rules engine is already running');
  if (!state.started) throw new EngineError('NOT_STARTED', 'deal the table first');
  const first = action.firstSeat ?? state.activeSeat;
  assertSeatIndex(state, first, 'firstSeat');
  /*
    Whatever is already on the battlefield gets its static abilities.

    A table can be switched into automated mode mid-game — that is the whole point of the tabletop
    half — and a board laid out by hand is a board of permanents the engine has never seen arrive.
    Without this, a Juggernaut already in play does not have to attack, a Fog Bank prevents nothing
    and a Paladin has no protection: printed abilities that simply are not there, with nothing to
    say so. The guard is the same one the arrivals pass uses, so a permanent whose effect is
    already installed is left alone.
  */
  let withStatics = state;
  for (const seat of state.seats) {
    for (const id of listAt(withStatics, zoneKey(seat.index, 'battlefield'))) {
      if (withStatics.effects.some((effect) => effect.source === id)) continue;
      const inst = withStatics.instances[id];
      if (inst === undefined) continue;
      withStatics = applyStatics(withStatics, id, inst.zoneSeat, scriptOf(withStatics, id));
    }
  }
  const next: GameState = {
    ...withStatics,
    automated: true,
    // `false` here means "nobody", which is what a test walking a game in lock-step asks for.
    autoPassOff: action.autoPass === false ? state.seats.map((seat) => seat.index) : [],
    // Opening hands come before the first turn (CR 103.4). Nobody holds priority and no step has
    // begun until every seat has settled, which is also what tells both clients to show the
    // mulligan decision rather than a board nobody can act on.
    openingHands: true,
    kept: [],
    activeSeat: first,
    step: 'untap',
    combat: EMPTY_COMBAT,
    pools: {},
    landsPlayed: {},
    passed: [],
    priority: null,
  };
  return {
    state: next,
    message: 'the rules engine takes over; keep or mulligan your opening hands',
    data: { openingHands: true, deciding: stillDeciding(next) },
  };
}

// ── Passing for a player with nothing to do ──────────────────────────────────────────────────────

/**
 * Passes on behalf of any player whose only legal move is to pass.
 *
 * This is the difference between an engine that is correct and one that is playable. Priority is
 * offered to every player in every step, which for a real game of Magic means a player with no
 * instants and nothing to activate is asked twenty-five times a turn to confirm that they still
 * cannot do anything. Nobody plays that twice.
 *
 * It takes nothing away, because it only acts when passing is the *only* legal move: a player with
 * no non-mana play has, by definition, no other choice. Mana abilities are excluded from that
 * count on purpose — floating mana you have nothing to spend on is not a reason to hold priority,
 * and counting it would mean a player with an untapped land never auto-passes at all.
 *
 * Four things always stop it, because each is a real decision:
 *
 *   - a combat declaration, which is a turn-based action rather than a priority one
 *   - a discard to hand size
 *   - any play at all, including a land
 *   - the start of a new turn, so a player always sees their own turn begin
 */
function autoPass(state: GameState): { state: GameState; passes: number } {
  let next = state;
  let passes = 0;
  for (let guard = 0; guard < 64; guard++) {
    if (next.finished || !next.automated || next.openingHands) break;
    if (next.pendingDiscard !== null || next.pendingChoice !== null) break;
    if (next.pendingDecision !== null) break;
    if (pendingDeclaration(next) !== null) break;
    const seat = next.priority;
    if (seat === null) break;
    // Asked of the seat holding priority rather than of the table: the player who wants every
    // step gets every step, and the player who did not is still passed for.
    if (!autoPassFor(next, seat)) break;
    if (legalActions(next, seat).plays.some((play) => !play.isManaAbility)) break;
    next = pass(next, { by: seat }).state;
    passes += 1;
    // One action never carries play past the beginning of somebody's turn.
    if (next.turn !== state.turn) break;
  }
  return { state: next, passes };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────────

function dispatch(state: GameState, action: AutoAction): Outcome {
  switch (action.type) {
    case 'auto:start': return startAutomation(state, action);
    case 'auto:playLand': return playLand(state, action);
    case 'auto:cast': return castSpell(state, action);
    case 'auto:activate': return activate(state, action);
    case 'auto:pass': return pass(state, action);
    case 'auto:attack': return declareAttackers(state, action);
    case 'auto:block': return declareBlockers(state, action);
    case 'auto:order': return orderDamage(state, action);
    case 'auto:discard': return discard(state, action);
    case 'auto:stops': return setStops(state, action);
    case 'auto:keep': return keepHand(state, action);
    case 'auto:choose': return chooseTargets(state, action);
    case 'auto:decide': return decide(state, action);
    default: {
      const exhaustive: never = action;
      throw new EngineError('INVALID_ACTION', `unknown action: ${String((exhaustive as { type?: string }).type)}`);
    }
  }
}

export function reduceAutoAction(state: GameState, action: AutoAction, _ctx: ActionContext): Outcome {
  const outcome = dispatch(state, action);
  const auto = autoPass(outcome.state);
  /*
    What replacement effects did, said on the message of the action that provoked them.

    A replaced death raises no event, so there is nothing for a trigger to log and nothing for the
    feed to pick up — the card would do its work invisibly, and a creature would turn up in exile
    with a Zombie beside it for no reason a player could see. Drained here because this is where
    every automated action passes on its way to a log entry.
  */
  const notes = auto.state.replacements;
  if (notes.length > 0) {
    const cleared = { ...auto.state, replacements: [] };
    const base = auto.passes === 0 ? outcome.message : `${outcome.message} — ${stepLabel(auto.state.step)}`;
    return {
      state: cleared,
      message: `${base} — ${notes.join('; ')}`,
      data: {
        ...(outcome.data ?? {}),
        ...(auto.passes === 0 ? {} : { autoPassed: auto.passes }),
        step: auto.state.step,
        replacements: [...notes],
      },
    };
  }
  if (auto.passes === 0) return outcome;
  // The log says where play ended up, because several steps may have gone by without anybody
  // being asked anything, and a log that said only "Nick passes" would be baffling.
  const moved = auto.state.step !== outcome.state.step || auto.state.turn !== outcome.state.turn;
  return {
    state: auto.state,
    message: moved ? `${outcome.message} — ${stepLabel(auto.state.step)}` : outcome.message,
    data: { ...(outcome.data ?? {}), autoPassed: auto.passes, step: auto.state.step },
  };
}

export { bottomOwed, sacrificeOptions, stillDeciding, canPay, hasAnyLegalTargets, MAIN_STEPS, pendingDeclaration, stackTop, stateBasedActions, legalAttackers, legalBlockers, poolOf, handOf, spellTargets };
