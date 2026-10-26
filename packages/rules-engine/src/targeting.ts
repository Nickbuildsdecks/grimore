/**
 * Choosing and validating targets.
 *
 * Targets are locked in when a spell goes on the stack and checked **again** when it resolves: a
 * spell whose targets have all become illegal does not resolve at all (CR 608.2b), which is what
 * makes killing the creature in response to a bolt work. Doing the check in one place means both
 * moments agree about what "legal" means, which is the only way that rule stays correct.
 */
import { characteristicsOf, hasType, parseTypeLine, protectionApplies } from './characteristics.js';
import { listAt } from './cardActions.js';
import { zoneKey } from './cards.js';
import type { TargetSpec } from './scriptTypes.js';
import { targetKey, type Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/**
 * The graveyard-pointing kinds, and the printed type each one requires. `null` means any card.
 *
 * One table rather than one branch per kind, because they differ only in that word: a card in a
 * graveyard is read from its printed type line in every case, since nothing continuous applies to
 * it. An entry here is what makes `graveyard-land` a kind rather than a filter every script that
 * wanted one would have to write again.
 */
const GRAVEYARD_KINDS: Readonly<Record<string, string | null | undefined>> = {
  'graveyard-creature': 'creature',
  'graveyard-land': 'land',
  'graveyard-card': null,
};

/**
 * Whether one candidate satisfies one spec, for a spell controlled by `controller`.
 *
 * Hexproof and shroud are checked here rather than in each script: they are properties of the
 * target, and a script that had to remember them would eventually forget.
 */
export function isLegalTarget(
  state: GameState, spec: TargetSpec, candidate: Target, controller: SeatIndex, source?: string,
): boolean {
  if (candidate.kind === 'player') {
    if (spec.kind !== 'player' && spec.kind !== 'any') return false;
    const seat = state.seats[candidate.seat];
    if (seat === undefined || seat.eliminated) return false;
    return spec.filter ? spec.filter(state, candidate, controller, source) : true;
  }

  /*
    An ability on the stack, and the whole of its legality: is it still there?

    Every check below this is about a card — a zone, a type line, a keyword, a colour — and an
    ability has none of those. It is not in a zone, it has no printed type, it cannot be given
    hexproof and nothing can protect it. So the list is short and it is complete: the spec has to
    be asking for an ability, and the object has to still be on the stack and still be an ability
    rather than a spell. When it has resolved it is simply gone, which is the fizzle rule doing its
    job one level up rather than anything special here (CR 608.2b).
  */
  if (candidate.kind === 'ability') {
    if (spec.kind !== 'ability' && spec.kind !== 'spell-or-ability') return false;
    const object = state.stackObjects[candidate.id];
    if (object === undefined || object.kind === 'spell') return false;
    return spec.filter ? spec.filter(state, candidate, controller, source) : true;
  }

  // The candidate is a card from here on, so a spec that only takes players or abilities cannot be
  // satisfied by it. Without this a "target player" spell accepts a creature, because none of the
  // checks below are about the spec's kind — a hand-built action would slip straight past them.
  if (spec.kind === 'player' || spec.kind === 'ability') return false;

  const inst = state.instances[candidate.id];
  if (inst === undefined) return false;

  // A spell *is* a card, which is why "counter target spell" needed no new target shape: the card
  // is physically in the stack zone and the object beside it describes how it was cast.
  if (spec.kind === 'spell' || spec.kind === 'spell-or-ability') {
    if (inst.zone !== 'stack') return false;
    return spec.filter ? spec.filter(state, candidate, controller, source) : true;
  }

  const wantedInGraveyard = GRAVEYARD_KINDS[spec.kind];
  if (wantedInGraveyard !== undefined) {
    if (inst.zone !== 'graveyard') return false;
    // A card in a graveyard has no continuous effects on it, so its printed type is what it is.
    if (wantedInGraveyard !== null
      && !hasType(parseTypeLine(state.cardDefs[inst.defKey]?.typeLine), wantedInGraveyard)) {
      return false;
    }
    return spec.filter ? spec.filter(state, candidate, controller, source) : true;
  }

  if (inst.zone !== 'battlefield') return false;
  const ch = characteristicsOf(state, inst);
  // "Any target" means a creature, a player or a planeswalker (CR 115.4) — never an untargetable
  // permanent. "Target creature" is creatures and nothing else, which is the difference: a
  // Lightning Bolt may be pointed at a planeswalker and a Pacifism may not.
  const isPlaneswalker = hasType(ch.typeLine, 'planeswalker');
  if (spec.kind === 'creature' && !ch.isCreature) return false;
  if (spec.kind === 'any' && !ch.isCreature && !isPlaneswalker) return false;
  // Hexproof stops opponents targeting it; shroud stops everyone.
  if (ch.keywords.has('shroud')) return false;
  if (ch.keywords.has('hexproof') && inst.zoneSeat !== controller) return false;
  // And protection stops anything of that colour, whoever controls it (CR 702.16c) — which is the
  // difference from hexproof: a white creature with protection from black cannot be Doom Bladed by
  // its own controller either, and a black creature with protection from black cannot target it.
  if (protectionApplies(state, ch.protectionFrom, source ?? null)) return false;
  return spec.filter ? spec.filter(state, candidate, controller, source) : true;
}

/** Everything that could legally be chosen for this spec right now. */
export function legalTargets(
  state: GameState, spec: TargetSpec, controller: SeatIndex, source?: string,
): Target[] {
  const out: Target[] = [];
  if (spec.kind === 'player' || spec.kind === 'any') {
    for (const seat of state.seats) {
      const candidate: Target = { kind: 'player', seat: seat.index };
      if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
    }
  }
  if (spec.kind === 'spell' || spec.kind === 'spell-or-ability') {
    for (const id of listAt(state, 'stack')) {
      const candidate: Target = { kind: 'card', id };
      if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
    }
  }
  /*
    And the abilities, which are not in the stack *zone* at all.

    The zone holds cards, and an ability has none — it exists only as an entry in `stackObjects`,
    so the list of candidates has to come from `stackOrder` with the spells filtered back out.
    That asymmetry is the reason this kind exists rather than being a filter on `spell`.
  */
  if (spec.kind === 'ability' || spec.kind === 'spell-or-ability') {
    for (const id of state.stackOrder) {
      if (state.stackObjects[id]?.kind === 'spell') continue;
      const candidate: Target = { kind: 'ability', id };
      if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
    }
  }
  if (spec.kind === 'spell' || spec.kind === 'ability' || spec.kind === 'spell-or-ability') return out;
  if (GRAVEYARD_KINDS[spec.kind] !== undefined) {
    for (const seat of state.seats) {
      for (const id of listAt(state, zoneKey(seat.index, 'graveyard'))) {
        const candidate: Target = { kind: 'card', id };
        if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
      }
    }
    return out;
  }
  if (spec.kind !== 'player') {
    for (const seat of state.seats) {
      for (const id of listAt(state, zoneKey(seat.index, 'battlefield'))) {
        const candidate: Target = { kind: 'card', id };
        if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
      }
    }
  }
  return out;
}

export interface TargetCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Validates a whole set of chosen targets against a spell's specs.
 *
 * Targets are matched to specs in order, each spec consuming as many as it asks for. Two targets of
 * the same spec must be different objects (CR 601.2c) — "deals 1 damage to two target creatures"
 * cannot both be the same creature.
 */
export function checkTargets(
  state: GameState,
  specs: readonly TargetSpec[],
  chosen: readonly Target[],
  controller: SeatIndex,
  source?: string,
): TargetCheck {
  let index = 0;
  const seen = new Set<string>();
  for (const spec of specs) {
    const want = Math.max(1, spec.count ?? 1);
    const available = legalTargets(state, spec, controller, source);
    const taken: Target[] = [];
    for (let i = 0; i < want && index < chosen.length; i++) {
      const candidate = chosen[index];
      if (candidate === undefined) break;
      if (!isLegalTarget(state, spec, candidate, controller, source)) {
        return { ok: false, reason: `that is not ${spec.description}` };
      }
      if (seen.has(targetKey(candidate))) {
        return { ok: false, reason: 'the same target cannot be chosen twice' };
      }
      seen.add(targetKey(candidate));
      taken.push(candidate);
      index += 1;
    }
    if (taken.length < want) {
      // "Up to" lets you choose fewer, including none; a required target does not.
      if (spec.optional) continue;
      if (available.length === 0) return { ok: false, reason: `there is no legal ${spec.description}` };
      return { ok: false, reason: `choose ${spec.description}` };
    }
  }
  if (index < chosen.length) return { ok: false, reason: 'too many targets chosen' };
  return { ok: true };
}

/**
 * Checks the division a dividing spell was cast with (CR 601.2d).
 *
 * Separate from `checkTargets` because it is a separate announcement: the targets are legal or
 * they are not, and the division is a sum that adds up or does not. Both are checked as the spell
 * is cast, and neither can be changed afterwards.
 *
 * Four refusals, and each one is a different mistake a client can make: a division sent for a
 * spell that divides nothing, a division that is not one number per target, a share of zero or
 * less, and a total that is not the whole amount. The last is the one that matters most — a spell
 * cast with two of its three damage assigned is a card that silently did less than it says.
 */
export function checkDivision(
  specs: readonly TargetSpec[],
  chosen: readonly Target[],
  division: readonly number[] | undefined,
): TargetCheck {
  const dividing = specs.filter((spec) => spec.divided !== undefined);
  if (dividing.length === 0) {
    return division === undefined || division.length === 0
      ? { ok: true }
      : { ok: false, reason: 'this spell has nothing to divide' };
  }
  /*
    One dividing spec, and it must be the only spec on the card.

    An honest refusal rather than a limit worth working around: with two specs the division would
    have to say which of them it is about, and every printed card that divides something divides
    it among *all* of its targets. If one ever does both, this is where it says so rather than
    dividing the wrong three damage among the wrong two creatures.
  */
  const spec = dividing[0];
  if (spec === undefined || specs.length > 1) {
    return { ok: false, reason: 'the engine cannot divide a spell that chooses more than one kind of target' };
  }
  const amount = spec.divided ?? 0;
  if (division === undefined) {
    return { ok: false, reason: `divide ${amount} among the targets` };
  }
  if (division.length !== chosen.length) {
    return { ok: false, reason: 'say how much each target is assigned, one number per target' };
  }
  for (const share of division) {
    if (!Number.isInteger(share) || share < 1) {
      // CR 601.2d: each target must be assigned at least one of whatever is divided. A target with
      // nothing assigned is not a target the spell took — it should not have been chosen.
      return { ok: false, reason: 'each target must be assigned at least one' };
    }
  }
  const total = division.reduce((sum, share) => sum + share, 0);
  if (total !== amount) {
    return { ok: false, reason: `all ${amount} must be assigned, and that is ${total}` };
  }
  return { ok: true };
}

/**
 * Records which object each card target is right now, to be stored on the stack object.
 *
 * Called wherever targets are written onto a stack object — a cast, an activation, a trigger, and
 * the answer to a trigger's "choose a target". See `StackObject.targetSeqs`.
 */
export function targetSeqsFor(
  state: GameState, targets: readonly Target[],
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const target of targets) {
    if (target.kind !== 'card') continue;
    out[target.id] = state.instances[target.id]?.objectSeq ?? 0;
  }
  return out;
}

/**
 * Changes what a stack object is pointed at (CR 114.6).
 *
 * The first thing in this engine that reaches into an object *already on the stack* and alters a
 * choice its controller made. Everything else reads the board and changes the board; this changes
 * what somebody else's spell is about, which is why it is here beside the legality rules rather
 * than in `effects.ts` with the things that deal damage.
 *
 * Three rules travel with it and all three are the rule rather than a policy:
 *
 * - The new target must be legal **for that spell**, judged with the spell's *own* controller as
 *   the chooser (CR 114.6c). A Doom Blade redirected onto a black creature does not change, and a
 *   hexproof creature is hexproof against the spell's controller, not against whoever is doing the
 *   redirecting.
 * - It must be a *different* target. "Change the target" is not satisfied by choosing the one it
 *   already has, and a card that let you would be a card that did nothing.
 * - If either fails, **nothing happens** — the spell keeps the target it had (CR 115.7b). It is not
 *   an error, and it is not a counter: a redirect that cannot land is a redirect that did not.
 *
 * Returns `null` for all three cases so the caller can say so in the log, rather than silently
 * handing back a state that looks changed.
 */
export function retarget(
  state: GameState, stackId: string, next: Target, spec: TargetSpec,
): GameState | null {
  const object = state.stackObjects[stackId];
  if (object === undefined || object.targets.length !== 1) return null;
  const current = object.targets[0];
  if (current === undefined || targetKey(current) === targetKey(next)) return null;
  /*
    The spell's controller is the chooser, which is the half that is easy to get wrong: this is not
    "may the Willbender's controller target that", it is "may the Doom Blade".

    And the **source** is the card, not the object on the stack. For a spell those are the same id;
    for an ability they are not — an ability's id is synthetic and names nothing in `instances`, so
    passing it would make protection from black miss an ability from a black permanent, which is a
    fact about the permanent (CR 702.16b) and not about the ability.
  */
  const sourceId = object.kind === 'spell' ? stackId : object.source;
  if (!isLegalTarget(state, spec, next, object.controller, sourceId)) return null;
  const targets: readonly Target[] = [next];
  return {
    ...state,
    stackObjects: {
      ...state.stackObjects,
      [stackId]: { ...object, targets, targetSeqs: targetSeqsFor(state, targets) },
    },
  };
}

/**
 * The chosen targets that are still the objects they were chosen as.
 *
 * A card that has changed zones since — exiled and returned by a Cloudshift, bounced and replayed
 * — is a new object and no longer a target of anything (CR 400.7, CR 608.2b), so it is dropped
 * here rather than checked for legality: it may well still *look* legal.
 */
export function liveTargets(
  state: GameState, targets: readonly Target[], seqs: Readonly<Record<string, number>> | undefined,
): readonly Target[] {
  if (seqs === undefined) return targets;
  return targets.filter((target) => stillTheObject(state, target, seqs));
}

/** Whether one chosen target is still the object it was chosen as. See `liveTargets`. */
export function stillTheObject(
  state: GameState, target: Target, seqs: Readonly<Record<string, number>> | undefined,
): boolean {
  if (seqs === undefined || target.kind !== 'card') return true;
  const was = seqs[target.id];
  return was === undefined || (state.instances[target.id]?.objectSeq ?? 0) === was;
}

/** Whether a spell on the stack still has at least one legal target, for the fizzle rule. */
export function stillHasLegalTarget(
  state: GameState, specs: readonly TargetSpec[], chosen: readonly Target[], controller: SeatIndex,
  source?: string,
): boolean {
  if (specs.length === 0 || chosen.length === 0) return true;
  return chosen.some((candidate) =>
    specs.some((spec) => isLegalTarget(state, spec, candidate, controller, source)),
  );
}

/** Whether every spec that must be satisfied can be, which decides if a spell is castable at all. */
export function hasAnyLegalTargets(
  state: GameState, specs: readonly TargetSpec[], controller: SeatIndex, source?: string,
): boolean {
  return specs.every((spec) => spec.optional || legalTargets(state, spec, controller, source).length > 0);
}
