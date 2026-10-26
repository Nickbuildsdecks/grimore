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
import { defKeyFor, zoneKey, type CardInstance } from './cards.js';
import { listAt, relocate, requireInstance, withInstance } from './cardActions.js';
import { characteristicsOf, hasType } from './characteristics.js';
import {
  advanceStep, aliveSeats, applyStatics, atSorcerySpeed, attackAimIssue, autoPassFor, bottomOwed,
  canAttack, canBlock, checkTargets, damageOrdersOwed, endTurnCleanup, forcedAttackers, legalAttackers,
  legalBlockers, menaceSatisfied, payFrom, pendingDeclaration, raiseUnblockedAttacks,
  answerDecision, modeCombinations, modeTargetSpecs, modesOf, prevAlive, pushAbility, raise,
  raiseWard, resetPriority, resolveTop, sacrificeOptions, scriptOf, settle, stackTop,
  stateBasedActions,
  stillDeciding, tapAttackers,
  type AutoAction, type AutoAttackAction, type AutoBlockAction, type AutoCastAction,
  type AutoOrderAction,
} from './automation.js';
import { addCounters, addToPool, counterSpell, loseLife, poolOf } from './effects.js';
import { assertSeatIndex, replaceSeat, seatName } from './internal.js';
import { canPay, parseManaCost, type ManaCost } from './mana.js';
import { scriptFor } from './scripts.js';
import { FORETELL_COST, MORPH_COST, type CardScript, type TargetSpec } from './scriptTypes.js';
import { checkDivision, hasAnyLegalTargets, targetSeqsFor } from './targeting.js';
import { markPactsBroken, pactLine, pactsBrokenBy } from './pacts.js';
import {
  convokePlan, costChangeFor, crewPlan, legalActions, manaSources, withCostChange,
} from './legalActions.js';
import {
  EMPTY_COMBAT, MAIN_STEPS, targetKey, type CombatAttack, type StackObject, type Target,
  type AutoTurnUpAction, type AutoForetellAction,
} from './turnTypes.js';
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
  // A commander is cast from the command zone (CR 903.8); everything else from hand — or, with
  // flashback, from its owner's graveyard (CR 702.33).
  const fromCommand = inst.zone === 'command' && inst.isCommander;
  const printedDef = state.cardDefs[inst.defKey];
  /*
    Which face of the card is being cast (CR 708).

    Everything below this block reads `def`, `script` and `characteristics`, and all three now come
    from the face rather than from the card — which is the whole of the mechanic: the cost paid, the
    timing checked, the targets offered, the effect run and the description both players read are
    the half's, because the half is what is on the stack.

    Two refusals, and they are opposite mistakes. A split card has **no** castable face of its own,
    so a cast with no half is refused rather than guessed at — "Cast Fire // Ice" is not a play, and
    a fallback would have silently cast whichever half happened to be first. And a card with no
    second face refuses a half outright, because a client sending one has misread the card.
  */
  const faces = printedDef?.faces;
  if (action.half !== undefined) {
    const face = faces?.cards[action.half];
    if (face === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE',
        `${printedDef?.name ?? 'that card'} has no face ${action.half}`);
    }
  } else if (faces?.kind === 'split') {
    throw new EngineError('RULE_NOT_APPLICABLE',
      `choose which half of ${printedDef?.name ?? 'that card'} to cast`);
  }
  const face = action.half === undefined ? undefined : faces?.cards[action.half];
  const faceKey = face === undefined ? undefined : defKeyFor(face);
  const def = face ?? printedDef;
  /*
    The instance as it will be *on the stack*, used for every characteristics question below.

    A copy rather than a write into `state`, because `state` is the before-picture `settle` compares
    against: the card does not become one half of itself until it is actually put on the stack, a
    few dozen lines down, and the engine must not be able to see a half-cast card in between.
  */
  const casting: CardInstance = faceKey === undefined ? inst : { ...inst, castAs: faceKey };
  const script = scriptFor(def?.name);
  const flashback = action.flashback === true;
  /*
    An adventurer being cast as its creature half, out of exile, because its adventure resolved.

    The same shape as foretell — a card in exile that one player may cast — and told apart from
    every other exiled card by the flag the adventure's resolution left on it. Casting the
    *adventure* half again is not a play: that half is gone, and `onAdventure` says so by being the
    only reason this card is castable at all.
  */
  const fromAdventure = action.half === undefined && inst.zone === 'exile'
    && inst.onAdventure === true && inst.zoneSeat === action.by;
  /*
    Foretell, the fourth zone a spell is cast from here (CR 702.143b).

    Three checks rather than one, and each refuses a different mistake: a card that was never
    foretold is not castable out of exile at all, a card foretold by somebody else is not yours to
    cast, and a card foretold **this turn** is not castable yet — which is the clause that stops
    foretell being a straight discount on a spell you were going to cast anyway.
  */
  const foretold = action.foretold === true;
  if (foretold) {
    if (script?.foretell === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${def?.name ?? 'that card'} has no foretell`);
    }
    if (inst.zone !== 'exile' || inst.foretoldTurn === undefined || inst.zoneSeat !== action.by) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that card was not foretold by you');
    }
    if (inst.foretoldTurn === state.turn) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'a foretold card cannot be cast on the turn it was foretold');
    }
  }
  if (flashback) {
    if (script?.flashback === undefined) {
      throw new EngineError('RULE_NOT_APPLICABLE', `${def?.name ?? 'that card'} has no flashback`);
    }
    // Its owner's graveyard and nobody else's: flashback is cast "from your graveyard", and the
    // card in there is the one you put there.
    if (inst.zone !== 'graveyard' || inst.zoneSeat !== action.by) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your graveyard');
    }
  } else if (!foretold && !fromCommand && !fromAdventure
    && (inst.zone !== 'hand' || inst.zoneSeat !== action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', inst.zone === 'exile' && inst.onAdventure === true
      ? 'that card is on an adventure in somebody else\'s exile'
      : 'that card is not in your hand');
  }
  if (fromCommand && inst.zoneSeat !== action.by) {
    throw new EngineError('FORBIDDEN', 'that is not your commander');
  }
  /*
    Morph, which is a different spell rather than a different cost: nothing below this line applies
    to it, so it is cast by its own function rather than by threading a flag through forty lines
    about modes, X, kickers and targets that a face-down spell cannot have.

    **Above** the land check, which is the whole of why Zoetic Cavern is in the pool. Morph does not
    care what the card is (CR 702.37a): a land card cast face down is a 2/2 creature spell, and a
    check that refused it for being a land would be reading the card this spell is deliberately not.
  */
  if (action.faceDown === true) return castFaceDown(state, action, inst, script);

  const characteristics = characteristicsOf(state, casting);
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
    The division, announced with the spell and with its targets (CR 601.2d).

    After the targets rather than with X and the modes, because it is a statement *about* the
    targets: "three damage divided" means nothing until there is a list to divide it among, and a
    division checked first would have to be re-checked once the list arrived.
  */
  const divided = checkDivision(specs, chosen, action.division);
  if (!divided.ok) throw new EngineError('RULE_NOT_APPLICABLE', divided.reason ?? 'that division does not add up');

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
  // Flashback *replaces* the cost rather than adding to it, which is the difference between it
  // and the kicker and the reason the two cannot both be paid on one casting.
  const costText = flashback
    ? script?.flashback?.cost
    // Foretell replaces the printed cost, like flashback, which is why it is in the same chain
    // rather than beside the kicker: a foretold spell is cast for one cost and not for two.
    : foretold ? script?.foretell?.cost
      : kicked ? `${def?.manaCost ?? ''}${script?.kicker?.cost ?? ''}` : def?.manaCost;
  /*
    And what the permanents on the table have done to the cost: a Goblin Electromancer, a Thalia.

    Through `costChangeFor`, which is the same function `legalActions` used to decide this cast was
    affordable — the offer and the payment asking one question of one state, which is the rule this
    file keeps for convoke, crew and morph too.

    Applied **after** the commander tax rather than before it, which is the ordering the rules give
    (CR 601.2f: increases, then reductions) and the only one that behaves: a reduction taken off the
    printed cost first would floor at nought and then have the tax added on top, so a taxed
    commander would come out cheaper than an untaxed one is dear.
  */
  const change = costChangeFor(state, action.by, def);

  /*
    Convoke, which widens what may pay rather than changing what it costs (CR 702.51).

    Worked out by the same `convokePlan` that decided whether to offer this cast at all, so the
    offer and the payment cannot disagree — the rule this file exists to keep. The creatures are
    tapped here, as the cost is paid, which is also what makes the "became tapped" triggers fire at
    the right moment: a City of Brass convoked for a spell charges its life now, not on resolution.

    Recomputed rather than carried on the action: it is a fact about the board at the moment of
    casting, and a client naming its own creatures to tap would be a client choosing which of its
    permanents the engine taps.
  */
  let convoked: readonly string[] = [];
  let toPay: string | ManaCost | undefined = costText;
  let taxToPay = tax;
  if (change.generic !== 0) {
    const printed = parseManaCost(costText);
    toPay = withCostChange(tax > 0 ? { ...printed, generic: printed.generic + tax } : printed, change.generic);
    // The tax is inside `toPay` now, so adding it again in `payFrom` would charge it twice.
    taxToPay = 0;
  }
  if (script?.convoke === true) {
    const printed = parseManaCost(costText);
    const taxed = tax > 0 ? { ...printed, generic: printed.generic + tax } : printed;
    const full = withCostChange(taxed, change.generic);
    const plan = convokePlan(state, action.by, full, manaSources(state, action.by));
    if (plan === null) {
      throw new EngineError('RULE_NOT_APPLICABLE', `cannot pay for ${characteristics.name}, even with convoke`);
    }
    convoked = plan.tapped;
    // The plan's cost already carries the tax, so it must not be added a second time.
    toPay = plan.cost;
    taxToPay = 0;
  }
  let beforePay = state;
  for (const id of convoked) beforePay = withInstance(beforePay, id, { tapped: true });
  const paid = payFrom(beforePay, action.by, toPay, action.x ?? 0, taxToPay);
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
  /*
    A foretold card turns face up as it is cast, which is the moment the hidden half of the mechanic
    ends: until now the opponent knew only that there was a card there.

    Needed explicitly because `relocate` carries `faceDown` onto the stack for morph's sake — the
    two mechanics want opposite things from the same field, and this is the one line that says so.
  */
  if (foretold) next = withInstance(next, inst.id, { faceDown: false });
  /*
    And a card coming back off an adventure stops being on one, because it is being cast.

    Cleared here rather than on resolution for the reason the flag exists: it is what makes this
    card castable out of exile, and a copy that kept it would be castable again from the graveyard
    it eventually reaches.
  */
  if (fromAdventure) next = withInstance(next, inst.id, { onAdventure: undefined });
  // The card physically moves to the stack, and an object describes how it was cast.
  next = relocate(next, requireInstance(next, inst.id), 'stack', action.by, 'bottom');
  /*
    And on the stack it is one half of itself (CR 708.4).

    After `relocate` rather than before, because `relocate` is the thing that clears this field on
    every zone change and setting it first would have it cleared on the way in.
  */
  if (faceKey !== undefined) next = withInstance(next, inst.id, { castAs: faceKey });
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
  // And flashback, for the third time for the same reason: a player deciding whether to counter a
  // spell cast out of a graveyard should be able to see that it is never coming back.
  const flashbackText = flashback ? ' (flashback)' : '';
  // And foretell, for the fourth time and the same reason: a spell coming out of exile for a
  // cheaper cost is a spell the player deciding whether to answer it should be able to read as one.
  const foretoldText = foretold ? ' (foretold)' : '';
  const object: StackObject = {
    id: inst.id, kind: 'spell', source: inst.id, controller: action.by,
    // The **face**, not the card: the stack object is what resolution reads the script off, and
    // the script that resolves is the half's.
    cardKey: faceKey ?? inst.defKey, targets: [...chosen], targetSeqs: targetSeqsFor(state, chosen),
    ...(action.x === undefined ? {} : { x: action.x }),
    ...(action.division === undefined ? {} : { division: [...action.division] }),
    ...(modes === undefined ? {} : { modes: [...modes] }),
    ...(kicked ? { kicked: true } : {}),
    // The flag the card's destination depends on: a spell cast from the graveyard is exiled as it
    // leaves the stack, and by then nothing else remembers where it came from.
    ...(flashback ? { flashback: true as const } : {}),
    /*
      And the other flag the destination depends on, for the same reason: an adventure that
      resolves is exiled "on an adventure" rather than put into a graveyard, and once it has left
      the stack nothing else knows which half was cast.

      Only when a face was actually cast. An adventurer cast as its creature half is an ordinary
      creature spell and goes to the battlefield like one.
    */
    ...(faces?.kind === 'adventure' && faceKey !== undefined ? { adventure: true as const } : {}),
    description: `${characteristics.name}${xText}${kickedText}${flashbackText}${foretoldText}${modeText}`,
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
    // Which spell, as well as what kind of spell: a Chalice of the Void has to read its mana value
    // and then counter that object. See the `spell-cast` event's `object`.
    object: object.id,
  }, action.by);
  // And ward, off the same cast, for everything the spell took aim at. After the cast triggers
  // rather than before: both happen as the spell is cast and go on the stack together, and this is
  // the order a player watched them in — the spell, then what it is pointed at answering.
  next = raiseWard(next, object.id);
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

/**
 * Casting a card face down as a 2/2 creature spell for {3} (CR 702.37a).
 *
 * Its own function, called out of `castSpell` before anything else happens, because a face-down
 * spell has **no text**: no modes to choose, no {X} to announce, no kicker, no additional cost, no
 * convoke and nothing to target. Each of those is refused rather than quietly dropped — an action
 * carrying one has misread the card, and a stack object carrying a mode or an X that the spell has
 * no text to read would be a lie the resolution could act on.
 *
 * It is a creature spell and nothing has given it flash, so it is a sorcery-speed play. Which is
 * also the rules answer rather than a simplification: morph grants no timing of its own.
 */
function castFaceDown(
  state: GameState, action: AutoCastAction, inst: CardInstance, script: CardScript | undefined,
): Outcome {
  const def = state.cardDefs[inst.defKey];
  if (script?.morph === undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${def?.name ?? 'that card'} has no morph`);
  }
  // From hand only. Morph is "you may cast this card as a 2/2 face-down creature spell", and the
  // card it says that about is the one in your hand.
  if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  if (action.flashback === true || action.kicked === true || action.x !== undefined
    || (action.modes !== undefined && action.modes.length > 0) || action.sacrifice !== undefined
    || (action.targets !== undefined && action.targets.length > 0)) {
    throw new EngineError('RULE_NOT_APPLICABLE',
      'a face-down spell has no text: no modes, no X, no kicker and nothing to target');
  }
  if (!atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE',
      'a face-down creature spell can only be cast in your main phase with an empty stack');
  }

  const paid = payFrom(state, action.by, MORPH_COST, 0, 0);
  // Face down *before* it moves, so `relocate` carries the bit to the stack rather than the card
  // arriving there face up for an instant that the view could have been taken in.
  let next = withInstance(paid.state, inst.id, { faceDown: true });
  next = relocate(next, requireInstance(next, inst.id), 'stack', action.by, 'bottom');
  /*
    The description is what the opponent reads, and it has to be the 2/2 rather than the card.

    `characteristicsOf` already answers this — a face-down object is a 2/2 with no name — so the
    description is taken from it rather than written out here, which is what keeps the two from
    drifting: if the face-down profile ever changes, the stack says the new thing.
  */
  const anonymous = characteristicsOf(next, requireInstance(next, inst.id));
  const object: StackObject = {
    id: inst.id, kind: 'spell', source: inst.id, controller: action.by,
    cardKey: inst.defKey, targets: [], targetSeqs: {},
    description: `${anonymous.name} (2/2)`,
  };
  next = {
    ...next,
    stackObjects: { ...next.stackObjects, [object.id]: object },
    stackOrder: [...next.stackOrder, object.id],
  };
  // A creature spell was cast, which is all a prowess or a "whenever an opponent casts a creature
  // spell" may know about it — the types come from the face-down profile, not from the card.
  next = raise(next, {
    kind: 'spell-cast',
    spell: 'creature',
    types: anonymous.typeLine.types.map((t) => t.toLowerCase()),
    object: object.id,
  }, action.by);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    message: `${seatName(state, action.by)} casts a face-down creature`,
    data: { card: inst.id, name: anonymous.name, tapped: [...paid.tapped], faceDown: true },
  };
}

/**
 * Foretelling: {2} to put a card from your hand into exile face down (CR 702.143a).
 *
 * A **special action**, like turning a morph face up, and the engine's second: no stack, nothing to
 * respond to, and taken during your own turn. The two are opposites — this one hides a card and
 * that one reveals one — and they are the only two moves at this table that an opponent cannot
 * answer at all.
 *
 * `foretoldTurn` is recorded here because it is the one thing the rules need remembered: a foretold
 * card cannot be cast on the turn it was foretold (CR 702.143b), which is what stops foretell being
 * a straight discount on a spell you were casting anyway.
 */
function foretell(state: GameState, action: AutoForetellAction): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'hand' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that card is not in your hand');
  }
  const def = state.cardDefs[inst.defKey];
  const script = scriptFor(def?.name);
  if (script?.foretell === undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${def?.name ?? 'that card'} has no foretell`);
  }
  // "During your turn" (CR 702.143a), which in this engine is the same window a sorcery gets.
  if (!atSorcerySpeed(state, action.by)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'foretell is taken during your own main phase, with nothing on the stack');
  }

  const paid = payFrom(state, action.by, FORETELL_COST, 0, 0);
  // Face down *before* the move, so `relocate` carries the bit into exile rather than the card
  // arriving there face up for an instant that a view could have been taken in.
  let next = withInstance(paid.state, inst.id, { faceDown: true, foretoldTurn: state.turn });
  next = relocate(next, requireInstance(next, inst.id), 'exile', action.by, 'bottom');
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    // Not named, which is the point of the mechanic: the log says a card was foretold and the
    // opponent can count it in exile without knowing what it is.
    message: `${seatName(state, action.by)} foretells a card`,
    data: { card: inst.id, tapped: [...paid.tapped], foretold: true },
  };
}

/**
 * Turning your own face-down permanent face up for its morph cost (CR 702.37b).
 *
 * A special action: it uses no stack and nobody gets priority in between, so there is no window to
 * answer it. That is the whole reason a player holds a morph rather than casting the creature —
 * two mana held up and a 2/2 that becomes something else in the middle of combat.
 *
 * It is **not** a new object (CR 702.37d). Nothing is relocated and nothing is reset: the creature
 * keeps its damage, its counters, whether it is tapped, what is attached to it and when it arrived,
 * so a morph that has been down since last turn can attack the moment it is turned up. One field
 * changes, and the abilities follow from the field because every one of them is computed from it
 * rather than installed — which is what the face-down work before this was for.
 */
function turnUp(state: GameState, action: AutoTurnUpAction): Outcome {
  requireAutomated(state);
  requirePriority(state, action.by);
  const inst = requireInstance(state, action.card);
  if (inst.zone !== 'battlefield' || inst.zoneSeat !== action.by) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that is not a permanent you control');
  }
  if (!inst.faceDown) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that permanent is already face up');
  }
  const def = state.cardDefs[inst.defKey];
  // `scriptFor` by name rather than `scriptOf` by id, which would be undefined: the whole point of
  // `scriptOf` is that a face-down permanent has no abilities, and this is the one place that has
  // to read the card underneath anyway.
  const script = scriptFor(def?.name);
  if (script?.morph === undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'that permanent has no morph cost to pay');
  }
  /*
    The cost, in two halves because a morph cost is not always mana (CR 702.37a lets a card print
    whatever it likes). The life half is checked before anything is spent and refused at exactly
    the life that would kill you — the same rule `activate` applies to an ability's `life` cost.
  */
  if (script.morph.cost.life !== undefined) {
    const life = state.seats[action.by]?.life ?? 0;
    if (life <= script.morph.cost.life) {
      throw new EngineError('RULE_NOT_APPLICABLE',
        `you do not have ${script.morph.cost.life} life to pay`);
    }
  }
  const paid = payFrom(state, action.by, script.morph.cost.mana, 0, 0);
  let next = withInstance(paid.state, inst.id, { faceDown: false });
  if (script.morph.cost.life !== undefined) {
    next = loseLife(next, action.by, script.morph.cost.life);
  }
  /*
    Megamorph's counter, put on here rather than by a trigger (CR 702.37c).

    Part of the same action as the turn-up, which is the whole reason it is three lines in this
    function instead of a `turned-face-up` trigger on each megamorph card: a trigger goes on the
    stack, and an opponent given a window between "it is face up" and "it is bigger" could remove
    the creature in response to its own counter. Turning a permanent face up is specifically the
    thing nobody may respond to, so both halves happen before anybody gets priority back.
  */
  if (script.morph.mega === true) {
    next = addCounters(next, inst.id, '+1/+1', 1);
  }
  /*
    Its static abilities, installed here, because `settle` installs them only for a permanent that
    *arrived* — and this one arrived face down, with no abilities to install.

    Guarded the same way the arrivals loop guards it, on there being no effect with this source
    already, which is what keeps a permanent that was turned face up, face down and face up again
    from handing out its anthem twice.
  */
  if (!next.effects.some((effect) => effect.source === inst.id)) {
    next = applyStatics(next, inst.id, inst.zoneSeat, script);
  }
  /*
    `settle` rather than a bare return, because turning a permanent face up changes the board in
    ways other cards were already watching: its own statics have to be installed, and a 2/2 that
    becomes a 5/5 or stops being a creature may settle a state-based action — a creature with
    lethal damage on it from combat dies the moment it turns up smaller, and one that turns up
    bigger survives damage it was already holding.
  */
  /*
    And its own trigger, which is the one hook morph needs and an entry trigger cannot give it
    (CR 702.37d).

    Raised before `settle` rather than after, so the ability goes on the stack and `settle` puts the
    priority back where a trigger leaves it: the turn-up itself cannot be answered, but what it
    *triggers* goes on the stack like anything else and both players get a window at it. That is
    the rule and it is also the only part of morph an opponent can interact with.
  */
  next = raise(next, { kind: 'turned-face-up' }, action.by, inst.id);
  next = settle(next, state);
  const now = characteristicsOf(next, requireInstance(next, inst.id));
  return {
    state: next,
    // Named, because this is the moment everybody else finds out what it was.
    message: `${seatName(state, action.by)} turns ${now.name} face up`,
    data: { card: inst.id, name: now.name, tapped: [...paid.tapped] },
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
  // One, plus whatever something has given you this turn (CR 505.5b). The allowance is read here
  // rather than decremented when it is given, so an Explore cast with the land drop still unused
  // is two lands and not one — which is what the card says and what a player expects.
  const allowed = 1 + (state.extraLands[String(action.by)] ?? 0);
  if (played >= allowed) {
    throw new EngineError('RULE_NOT_APPLICABLE', played > 1
      ? `you have already played ${played} lands this turn`
      : 'you have already played a land this turn');
  }

  let next = relocate(state, inst, 'battlefield', action.by, 'bottom');
  next = { ...next, landsPlayed: { ...next.landsPlayed, [String(action.by)]: played + 1 } };
  /*
    No entry trigger raised here, and that is a fix rather than an omission.

    `settle`'s arrivals loop is the one place that sees *every* way onto the battlefield and raises
    `etb` there — so this line used to raise it a **second** time for a land played from hand, and
    any watcher saw one land drop as two. Nothing in the pool could hear a land entering until
    Tatyova, which is why a double fire sat here unnoticed: her first test drew two cards off one
    Forest.
  */
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

  if (ability.cost.removeCounter !== undefined) {
    // The same rule as the life and the loyalty: a cost you cannot pay is not one you may choose
    // to pay (CR 118.4), so this is refused before anything else is spent.
    const { counter, amount } = ability.cost.removeCounter;
    if ((inst.counters[counter] ?? 0) < amount) {
      throw new EngineError('RULE_NOT_APPLICABLE',
        `${ch.name} does not have ${amount === 1 ? 'a' : amount} ${counter} counter${amount === 1 ? '' : 's'} to remove`);
    }
  }

  const specs = ability.targets ?? [];
  const chosen = action.targets ?? [];
  const check = checkTargets(state, specs, chosen, action.by, inst.id);
  if (!check.ok) throw new EngineError('RULE_NOT_APPLICABLE', check.reason ?? 'illegal targets');

  /*
    An **ability** that divides a quantity is refused rather than resolved as if it divided nothing.

    `AutoActivateAction` carries no division, because no ability in the pool divides anything — and
    the day one does, this is the line that says so instead of the ability silently dealing its
    whole amount to the first target. An honest refusal beats a card that looks like it works.
  */
  if (specs.some((spec) => spec.divided !== undefined)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'the engine cannot divide an activated ability yet');
  }

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

  /*
    Crew, worked out before anything is spent and paid with the mana (CR 702.122a).

    Recomputed by `crewPlan` rather than carried on the action, exactly as convoke is: which
    creatures get tapped is a fact about the board at this moment, and a client naming its own
    creatures would be a client choosing which of its permanents the engine taps.
  */
  let crewed: readonly string[] = [];
  if (ability.cost.crew !== undefined) {
    const plan = crewPlan(state, action.by, ability.cost.crew, inst.id);
    if (plan === null) {
      throw new EngineError('RULE_NOT_APPLICABLE',
        `you have no creatures untapped with total power ${ability.cost.crew} to crew ${ch.name}`);
    }
    crewed = plan;
  }

  // The permanent's own mana is the last mana spent on its own ability. See `payFrom`.
  const paid = payFrom(state, action.by, ability.cost.mana, 0, 0, action.card);
  let next = paid.state;
  // Tapped as the cost is paid, which is also what makes a "becomes tapped" trigger fire at the
  // right moment — and what stops those creatures attacking this turn, which is the price.
  for (const id of crewed) next = withInstance(next, id, { tapped: true });
  if (ability.cost.life !== undefined) next = loseLife(next, action.by, ability.cost.life);
  /*
    The counter comes off as the cost is paid, before the ability is on the stack.

    Which is the whole of why a Walking Ballista works: removing its last counter makes it a 0/0,
    and the state-based actions kill it while its own damage is still waiting to resolve. The
    damage is dealt anyway — an ability on the stack is independent of its source (CR 608.2) — and
    that is the card people play, not an edge case. A loyalty cost is paid in the same place for
    the same reason.
  */
  if (ability.cost.removeCounter !== undefined) {
    next = addCounters(next, inst.id,
      ability.cost.removeCounter.counter, -ability.cost.removeCounter.amount);
  }
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
  // Ward triggers off an ability as readily as off a spell (CR 702.21b) — an Icy Manipulator aimed
  // at a warded creature is exactly the case the keyword is printed for. See `raiseWard`.
  next = raiseWard(next, next.stackOrder[next.stackOrder.length - 1]!);
  next = resetPriority(settle(next, state), action.by);
  return {
    state: next,
    message: sacrificed !== null
      ? `${seatName(state, action.by)} sacrifices ${sacrificedName} and activates ${ch.name}`
      : crewed.length > 0
        // Said as a count, because the creatures turning sideways are the cost a player is paying
        // and the log is where they read what just happened to their board.
        ? `${seatName(state, action.by)} taps ${crewed.length} to crew ${ch.name}`
        : `${seatName(state, action.by)} activates ${ch.name}`,
    data: {
      card: inst.id, ability: action.abilityIndex,
      ...(sacrificed === null ? {} : { sacrificed }),
      ...(crewed.length === 0 ? {} : { crewed: [...crewed] }),
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
  if (state.pendingPayment !== null) {
    throw new EngineError('RULE_NOT_APPLICABLE', `${state.pendingPayment.prompt} must be answered first`);
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

  /*
    And whose word this breaks (see `GameState.pacts`).

    Read before the declaration is applied and recorded with it, because a broken deal is part of
    the same event as the attack that broke it. Nothing above this line consulted a pact: every
    check that could refuse an attack has already run, and an attack that breaks a promise is
    legal. All that happens is that the table finds out.
  */
  const broken = pactsBrokenBy(state, action.by, attacks.map((a) => a.defender));

  let next: GameState = {
    ...state,
    pacts: markPactsBroken(state.pacts, broken),
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
        // "Attacks alone": one creature in the whole declaration (CR 702.90b). Read here because
        // this is the only place that knows — by the time an exalted trigger resolves, a second
        // attacker could have been removed from combat and the board would say the same thing
        // either way.
        alone: attacks.length === 1,
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
    message: (attacks.length === 0
      ? `${seatName(state, action.by)} attacks with nothing`
      : `${seatName(state, action.by)} attacks: ${attacks
          .map((a) => `${cardName(state, a.attacker)} at ${a.planeswalker === undefined
            ? seatName(state, a.defender)
            : cardName(state, a.planeswalker)}`)
          .join(', ')}`)
      // Said on the attack rather than in a line of its own, because it is not a second thing that
      // happened: breaking your word *is* this attack, read by a table that remembers the deal.
      + broken.map((p) => ` — breaking a deal: ${pactLine(state, p.from, p.to, p.kind)}`).join(''),
    data: {
      attackers: attacks.map((a) => a.attacker),
      ...(broken.length === 0 ? {} : { brokePacts: broken.map((p) => p.id) }),
    },
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
  /*
    One event per block, carrying which attacker it was against (CR 509.1a).

    The blocking creature is the subject and the attacker travels on the event, which is the
    opposite way round from how the card reads — "whenever ~ blocks a creature, **that creature**
    doesn't untap" — and the right way round for the engine: the subject is what `who: 'self'` is
    asked about, and the card whose trigger this is is the one that blocked. See the `blocks` event.
  */
  for (const attack of attacks) {
    if (attack.defender !== action.by) continue;
    for (const blocker of attack.blockers) {
      next = raise(
        next,
        { kind: 'blocks', subjectSeat: action.by, blocked: attack.attacker },
        action.by,
        blocker,
      );
      /*
        And the same block from the attacker's side, once per blocker (CR 509.1h).

        Two events rather than one with a flag, because they are about different creatures: the
        subject of a block is the creature that blocked and the subject of becoming blocked is the
        creature that was attacking. A card with both halves — "whenever ~ blocks or becomes
        blocked by a creature" — carries two triggers and reads `c.blocked` in each, which is the
        other creature both times.
      */
      next = raise(
        next,
        { kind: 'becomes-blocked', subjectSeat: state.activeSeat, blocked: blocker },
        action.by,
        attack.attacker,
      );
    }
  }
  /*
    And "attacks and isn't blocked", which can only be asked once every defender has spoken.

    Guarded inside `raiseUnblockedAttacks` rather than here, because this is not the only way a
    seat comes to have declared: a defender with nothing that could legally block is declared for
    by the step itself, and that path has to raise the same events. What the guard is *not* is
    "`pendingDeclaration` returns null" — in a pod that is also waiting on the attacking player's
    damage assignment order (CR 509.2), and an unblocked attacker is unblocked whether or not
    somebody owes an order for a different attack. The real sequence puts these triggers on the
    stack after the order is settled (CR 509.4), which is unobservable here: priority does not
    return while the order is owed, so nothing can resolve or respond in between either way.
  */
  next = raiseUnblockedAttacks(next);
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
  // And a *trigger* that divides something, refused for the same reason an activated ability is:
  // `auto:choose` carries no division, so resolving one would deal its whole amount to one target.
  if (specs.some((spec) => spec.divided !== undefined)) {
    throw new EngineError('RULE_NOT_APPLICABLE', 'the engine cannot divide a triggered ability yet');
  }

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
  // The ability has its targets now, which is the moment ward's event happens for a trigger the
  // engine could not aim on its own. See `raiseWard`.
  next = raiseWard(next, object.id);
  next = resetPriority(settle(next, state));
  return {
    state: next,
    message: `${seatName(state, action.by)} aims ${object.description}`,
    data: { ability: object.id, targets: action.targets.length },
  };
}

/**
 * Answers a ward: pay the cost, or let the spell or ability be countered (CR 702.21b).
 *
 * The one question in this engine asked of a player because of somebody else's permanent, which is
 * why the authorisation check here is `pending.seat !== action.by` written out rather than
 * `assertMayActFor`: the host may drive a seat's own decisions, and this is not one of them — it
 * belongs to whoever did the targeting, and nobody else gets to answer it for them. The same
 * reasoning as a deal offered to another player.
 *
 * Declining is a real answer. A player who would rather keep the mana says so and the spell is
 * countered, which is the whole point of ward being a cost rather than hexproof: the removal is
 * still answered, but it cost the warded creature's controller nothing and the attacker a card.
 *
 * `payFrom` taps for the shortfall, so the answer really is one button. By the time it arrives
 * `settlePayment` has already ruled out the case where the cost cannot be met at all, so a refusal
 * here means the state moved underneath the table rather than that the player is short.
 */
function payWard(state: GameState, action: { by: SeatIndex; pay: boolean }): Outcome {
  requireAutomated(state);
  const pending = state.pendingPayment;
  if (pending === null) throw new EngineError('RULE_NOT_APPLICABLE', 'nothing is waiting to be paid');
  if (pending.seat !== action.by) throw new EngineError('FORBIDDEN', 'that payment is not yours to make');
  if (typeof action.pay !== 'boolean') throw new EngineError('INVALID_ACTION', 'say whether you are paying');
  const warded = state.cardDefs[state.instances[pending.source]?.defKey ?? '']?.name ?? 'a ward';
  const object = state.stackObjects[pending.counters];
  const spell = object?.description ?? 'it';

  let next: GameState = { ...state, pendingPayment: null };
  if (action.pay) {
    const paid = payFrom(next, action.by, pending.cost, 0);
    next = resetPriority(settle(paid.state, state));
    return {
      state: next,
      message: `${seatName(state, action.by)} pays ${pending.cost} for ${warded}'s ward`,
      data: { ward: pending.source, cost: pending.cost, paid: true, tapped: [...paid.tapped] },
    };
  }
  next = resetPriority(settle(counterSpell(next, pending.counters), state));
  return {
    state: next,
    message: `${seatName(state, action.by)} does not pay ${pending.cost}: ${spell} is countered by ${warded}'s ward`,
    data: { ward: pending.source, cost: pending.cost, paid: false, countered: pending.counters },
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
function decide(
  state: GameState,
  action: {
    by: SeatIndex; cards?: readonly string[]; option?: string; amount?: number; target?: Target;
  },
): Outcome {
  requireAutomated(state);
  const pending = state.pendingDecision;
  if (pending === null) throw new EngineError('RULE_NOT_APPLICABLE', 'nothing is waiting on a decision');
  if (pending.seat !== action.by) throw new EngineError('FORBIDDEN', 'it is not your decision to make');
  /*
    A question whose answer is a word, answered.

    The option is checked against the list the engine put on the question rather than against the
    script, for the same reason the card candidates are: that list is the *authorisation*, and it
    was computed when the question was asked. A crafted action naming a word nobody offered is
    refused here and nowhere else.
  */
  if (pending.options !== undefined) {
    const picked = action.option;
    if (picked === undefined) throw new EngineError('RULE_NOT_APPLICABLE', 'choose one of the options');
    if (!pending.options.includes(picked)) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that is not one of the choices');
    }
    const resumedChoice = answerDecision(state, [], picked);
    const settledChoice = resumedChoice.state.pendingDecision === null
      ? resetPriority(settle(resumedChoice.state, state))
      : settle(resumedChoice.state, state);
    return {
      state: settledChoice,
      message: `${seatName(state, action.by)} chooses ${picked} — ${resumedChoice.message}`,
    };
  }
  /*
    A question whose answer is a number, answered — and checked against the range the engine put on
    the question, for the same reason the words and the cards are. That range *is* the
    authorisation: it was computed from the board when the question was asked, so a crafted action
    paying nine life out of a four-life range is refused here and nowhere else.
  */
  if (pending.numbers !== undefined) {
    const { min, max } = pending.numbers;
    const picked = action.amount;
    if (picked === undefined || !Number.isInteger(picked)) {
      throw new EngineError('RULE_NOT_APPLICABLE', `choose a number between ${min} and ${max}`);
    }
    if (picked < min || picked > max) {
      throw new EngineError('RULE_NOT_APPLICABLE', `that number must be between ${min} and ${max}`);
    }
    const resumedNumber = answerDecision(state, [], undefined, picked);
    const settledNumber = resumedNumber.state.pendingDecision === null
      ? resetPriority(settle(resumedNumber.state, state))
      : settle(resumedNumber.state, state);
    return {
      state: settledNumber,
      message: `${seatName(state, action.by)} chooses ${picked} — ${resumedNumber.message}`,
    };
  }
  /*
    A question about where something else on the stack is pointed, answered — and the list the
    engine offered is the authorisation again, the same as the words and the numbers.

    Declining is a real answer here ("you may choose new targets"), so an action with no target is
    accepted rather than refused. What is refused is a target the question did not offer: a crafted
    action cannot aim a copy at a creature with shroud, at a permanent that is not a legal target
    for the spell being copied, or at a card that has since left the battlefield.
  */
  if (pending.targetChoices !== undefined) {
    const picked = action.target;
    const offered = pending.targetChoices;
    if (picked !== undefined && !offered.some((t) => targetKey(t) === targetKey(picked))) {
      throw new EngineError('RULE_NOT_APPLICABLE', 'that is not one of the targets on offer');
    }
    const resumedTarget = answerDecision(state, [], undefined, undefined, picked);
    const settledTarget = resumedTarget.state.pendingDecision === null
      ? resetPriority(settle(resumedTarget.state, state))
      : settle(resumedTarget.state, state);
    return {
      state: settledTarget,
      message: picked === undefined
        ? `${seatName(state, action.by)} leaves it where it was — ${resumedTarget.message}`
        : `${seatName(state, action.by)} re-aims it — ${resumedTarget.message}`,
    };
  }
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
  /*
    A card the engine cannot read is a card an automated game cannot deal.

    A pasted decklist becomes real cards wherever the pool has the name and **cardboard** wherever
    it does not — a name and nothing else, which is exactly what a kitchen table is (see
    `customDeck`). The tabletop plays that perfectly; the engine cannot, because a card with no
    type line is not a land, not a creature and not a spell, and a game dealt with one in the deck
    has a card in it that neither side can do anything with.

    So it is refused here, by name, rather than at the point the deck is loaded: loading it is
    exactly what the tabletop wants. This is the enforcement, and the lobby's "tabletop only" badge
    is a report of it — asserted where it is enforced, which is the rule D132 set for the privacy
    default and the same one applies to a refusal.
  */
  const blank = Object.values(state.cardDefs).find((def) => def.typeLine.trim().length === 0);
  if (blank !== undefined) {
    throw new EngineError('RULE_NOT_APPLICABLE',
      `the engine does not know ${blank.name}: a pasted list plays on the tabletop, not with the rules engine`);
  }
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
    extraLands: {},
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
    if (next.pendingDecision !== null || next.pendingPayment !== null) break;
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
    case 'auto:pay': return payWard(state, action);
    case 'auto:turnUp': return turnUp(state, action);
    case 'auto:foretell': return foretell(state, action);
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
