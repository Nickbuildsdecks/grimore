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
  characteristicsOf, expireEffects, hasSubtype, type ContinuousEffect,
} from './characteristics.js';
import { zoneKey, type CardDef } from './cards.js';
import { listAt, relocate, requireInstance, withInstance, withZones } from './cardActions.js';
import {
  canAttack, canBlock, dealCombatDamage, legalAttackers, legalBlockers, menaceSatisfied,
  needsFirstStrikeStep, tapAttackers,
} from './combat.js';
import { destroy, draw, poolOf, setPool, untapAll, type EffectContext, type EffectFn } from './effects.js';
import { EngineError, type GameState, type Outcome, type SeatIndex } from './types.js';
import {
  EMPTY_POOL, addMana, canPay, parseManaCost, payCost, solveTap,
  type ManaPool, type ManaType,
} from './mana.js';
import { replaceSeat, seatName } from './internal.js';
import { scriptFor } from './scripts.js';
import type { AbilityDef, CardScript, TargetSpec, TriggerEvent } from './scriptTypes.js';
import { checkTargets, hasAnyLegalTargets, legalTargets, stillHasLegalTarget } from './targeting.js';
import {
  EMPTY_COMBAT, MAIN_STEPS, NO_PRIORITY_STEPS, STEPS, STEP_LABELS,
  type StackObject, type Step, type Target,
} from './turnTypes.js';

export const MAX_HAND_SIZE = 7;

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────

// The action shapes live in `turnTypes.ts` so `types.ts` can put them in the Action union
// without importing this module, which imports `types.ts` itself.
export type {
  AutoAction, AutoStartAction, AutoPlayLandAction, AutoCastAction, AutoActivateAction,
  AutoPassAction, AutoAttackAction, AutoBlockAction, AutoDiscardAction,
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
): { readonly kind: 'attackers' | 'blockers'; readonly seats: readonly SeatIndex[] } | null {
  if (!state.automated) return null;
  if (state.step === 'declare-attackers' && !state.combat.attackersDeclared) {
    return { kind: 'attackers', seats: [state.activeSeat] };
  }
  if (state.step === 'declare-blockers') {
    const defenders = [...new Set(state.combat.attacks.map((a) => a.defender))].filter(
      (seat) => !state.combat.blockersDeclaredBy.includes(seat) && state.seats[seat]?.eliminated === false,
    );
    if (defenders.length > 0) return { kind: 'blockers', seats: defenders };
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
function resetPriority(state: GameState, to: SeatIndex = state.activeSeat): GameState {
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
      return { ...next, combat: EMPTY_COMBAT };

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
    if (inst.damage !== 0 || inst.counters['deathtouched'] !== undefined) {
      const counters = { ...inst.counters };
      delete counters['deathtouched'];
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
    case 'etb':
    case 'dies':
    case 'attacks':
    case 'becomes-tapped':
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
function raise(
  state: GameState, event: TriggerEvent, actor?: SeatIndex, subject?: string,
): GameState {
  let next = state;
  const selfEvents = new Set(['etb', 'dies', 'attacks', 'becomes-tapped']);
  const candidates = selfEvents.has(event.kind)
    ? subject === undefined ? [] : [subject]
    : next.seats.flatMap((s) => [...listAt(next, zoneKey(s.index, 'battlefield'))]);

  for (const id of candidates) {
    const inst = next.instances[id];
    if (inst === undefined) continue;
    // A `dies` trigger fires from the graveyard, so that one does not require the battlefield.
    if (event.kind !== 'dies' && inst.zone !== 'battlefield') continue;
    const script = scriptOf(next, id);
    if (script?.triggers === undefined) continue;
    for (let i = 0; i < script.triggers.length; i++) {
      const trigger = script.triggers[i]!;
      if (!triggerMatches(event, trigger.on, inst.zoneSeat, actor)) continue;
      next = pushAbility(next, id, inst.zoneSeat, i, [], 'triggered', trigger.description);
    }
  }
  return next;
}

function pushAbility(
  state: GameState, source: string, controller: SeatIndex, abilityIndex: number,
  targets: readonly Target[], kind: 'activated' | 'triggered', description: string,
): GameState {
  const seq = state.autoSeq + 1;
  const id = `ab${seq}`;
  const inst = state.instances[source];
  const object: StackObject = {
    id, kind, source, controller,
    cardKey: inst?.defKey ?? '',
    abilityIndex, targets: [...targets], description,
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

        if (!ch.isCreature) continue;
        const lethal = ch.toughness <= 0 || inst.damage >= ch.toughness || inst.counters['deathtouched'] !== undefined;
        if (!lethal) continue;
        if (ch.keywords.has('indestructible') && ch.toughness > 0) continue;
        const died = next.instances[id];
        next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
        if (died !== undefined) next = raise(next, { kind: 'dies' }, inst.zoneSeat, id);
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
function settle(state: GameState, before: GameState): GameState {
  let next = stateBasedActions(state);
  for (const seat of next.seats) {
    const was = before.seats[seat.index];
    if (was === undefined || seat.eliminated) continue;
    if (seat.life > was.life) next = raise(next, { kind: 'life-gained' }, seat.index);
  }
  return stateBasedActions(next);
}

// ── Casting, activating, resolving ───────────────────────────────────────────────────────────────

/**
 * Permanents the engine may tap on a player's behalf to pay a cost.
 *
 * Only abilities that are free, need nothing but a tap, and add a fixed amount of mana. An ability
 * that costs mana would need mana first; one offering a *choice* of colours cannot be described as
 * a fixed `produces` and is left out rather than guessed at, so the worst case for such a card is
 * that the player taps it by hand. A creature's mana ability is excluded while it is summoning
 * sick, same as any other tap ability (CR 302.6).
 */
export function manaSources(
  state: GameState, seat: SeatIndex,
): { readonly key: string; readonly produces: readonly ManaType[]; readonly abilityIndex: number }[] {
  const out: { key: string; produces: readonly ManaType[]; abilityIndex: number }[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities = script?.abilities ?? [];
    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if (ability.produces === undefined || ability.produces.length === 0) continue;
      if (ability.cost.mana !== undefined) continue;
      if (!ability.cost.tap) continue;
      if (ability.cost.sacrificeSelf) continue;
      if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      // One source per permanent: tapping it is what pays, so a second ability on the same
      // permanent is not a second source.
      out.push({ key: id, produces: ability.produces as readonly ManaType[], abilityIndex: i });
      break;
    }
  }
  return out;
}

/** Taps the chosen permanents and puts their mana in the pool. */
function tapSources(
  state: GameState, seat: SeatIndex,
  sources: readonly { key: string; produces: readonly ManaType[] }[], keys: readonly string[],
): GameState {
  let next = state;
  for (const key of keys) {
    const source = sources.find((s) => s.key === key);
    if (source === undefined) continue;
    next = withInstance(next, key, { tapped: true });
    for (const type of source.produces) next = setPool(next, seat, addMana(poolOf(next, seat), type, 1));
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
  state: GameState, seat: SeatIndex, costText: string | undefined, x: number,
): { state: GameState; tapped: readonly string[] } {
  const cost = parseManaCost(costText);
  let next = state;
  let tapped: readonly string[] = [];
  if (!canPay(poolOf(next, seat), cost, x)) {
    const sources = manaSources(next, seat);
    const plan = solveTap(poolOf(next, seat), cost, sources, x);
    if (plan !== null) {
      next = tapSources(next, seat, sources, plan);
      tapped = plan;
    }
  }
  const result = payCost(poolOf(next, seat), cost, x);
  if (!result.paid) throw new EngineError('RULE_NOT_APPLICABLE', `cannot pay ${costText ?? '{0}'}: ${result.shortfall}`);
  return { state: setPool(next, seat, result.pool as ManaPool), tapped };
}

/** Resolves the object on top of the stack. */
export function resolveTop(state: GameState): { state: GameState; message: string } {
  const object = stackTop(state);
  if (object === undefined) return { state, message: 'nothing to resolve' };
  let next: GameState = {
    ...state,
    stackOrder: state.stackOrder.slice(0, -1),
  };
  const objects = { ...next.stackObjects };
  delete objects[object.id];
  next = { ...next, stackObjects: objects };

  const script = scriptFor(next.cardDefs[object.cardKey]?.name);
  const specs: readonly TargetSpec[] =
    object.kind === 'spell'
      ? script?.targets ?? (script?.aura ? [script.aura.target] : [])
      : abilityOrTrigger(script, object)?.targets ?? [];

  // A spell or ability whose targets have all become illegal does not resolve at all (CR 608.2b).
  if (specs.length > 0 && !stillHasLegalTarget(next, specs, object.targets, object.controller)) {
    const name = next.cardDefs[object.cardKey]?.name ?? 'it';
    if (object.kind === 'spell') {
      const inst = next.instances[object.id];
      if (inst !== undefined) next = relocate(next, inst, 'graveyard', inst.owner, 'bottom');
    }
    return { state: next, message: `${name} is countered: its targets are gone` };
  }

  const ctx: EffectContext = {
    state: next,
    source: object.kind === 'spell' ? object.id : object.source,
    controller: object.controller,
    targets: object.targets,
    x: object.x ?? 0,
  };

  if (object.kind === 'spell') {
    const inst = next.instances[object.id];
    const def = next.cardDefs[object.cardKey];
    const isPermanent = inst !== undefined && isPermanentCard(def);
    if (script?.onResolve) next = script.onResolve({ ...ctx, state: next });
    if (isPermanent && inst !== undefined) {
      next = relocate(next, requireInstance(next, inst.id), 'battlefield', object.controller, 'bottom');
      if (script?.aura) {
        const host = object.targets.find((t) => t.kind === 'card');
        if (host && host.kind === 'card') {
          next = withInstance(next, inst.id, { attachedTo: host.id });
          next = addAuraEffect(next, inst.id, object.controller, host.id, script);
        }
      }
      next = applyStatics(next, inst.id, object.controller, script);
      next = raise(next, { kind: 'etb' }, object.controller, inst.id);
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
    ...(script.aura.effect.power === undefined ? {} : { power: script.aura.effect.power }),
    ...(script.aura.effect.toughness === undefined ? {} : { toughness: script.aura.effect.toughness }),
    ...(script.aura.effect.keywords ? { keywords: script.aura.effect.keywords } : {}),
    ...(script.aura.effect.cantAttack ? { cantAttack: true } : {}),
    ...(script.aura.effect.cantBlock ? { cantBlock: true } : {}),
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
      : { kind: 'all-creatures' };
    next = {
      ...next,
      autoSeq: seq,
      effects: [...next.effects, {
        id: `fx${seq}`, source: id, controller, scope, duration: 'permanent', createdTurn: next.turn,
        ...(entry.effect.power === undefined ? {} : { power: entry.effect.power }),
        ...(entry.effect.toughness === undefined ? {} : { toughness: entry.effect.toughness }),
        ...(entry.effect.keywords ? { keywords: entry.effect.keywords } : {}),
      }],
    };
  }
  return next;
}

export { legalTargets, hasAnyLegalTargets, checkTargets, scriptOf, raise, nextAlive, prevAlive, aliveSeats, resetPriority, advanceStep, payFrom, pushAbility, settle, canAttack, canBlock, legalAttackers, legalBlockers, menaceSatisfied, needsFirstStrikeStep, tapAttackers, destroy, STEP_LABELS };
