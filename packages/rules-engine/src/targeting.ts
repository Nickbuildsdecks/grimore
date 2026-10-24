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

  // The candidate is a card from here on, so a spec that only takes players cannot be satisfied by
  // it. Without this a "target player" spell accepts a creature, because none of the checks below
  // are about the spec's kind — a hand-built action would slip straight past them.
  if (spec.kind === 'player') return false;

  const inst = state.instances[candidate.id];
  if (inst === undefined) return false;

  if (spec.kind === 'spell') {
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
  if (spec.kind === 'spell') {
    for (const id of listAt(state, 'stack')) {
      const candidate: Target = { kind: 'card', id };
      if (isLegalTarget(state, spec, candidate, controller, source)) out.push(candidate);
    }
    return out;
  }
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
  return targets.filter((target) => {
    if (target.kind !== 'card') return true;
    const was = seqs[target.id];
    return was === undefined || (state.instances[target.id]?.objectSeq ?? 0) === was;
  });
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
