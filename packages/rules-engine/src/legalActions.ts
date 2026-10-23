/**
 * What a player can legally do right now.
 *
 * The client never has to know a rule: it asks for this and renders it. That keeps the rules in one
 * place — a UI that decided for itself whether a card was castable would be a second, worse copy of
 * the engine, and the two would disagree the moment either changed.
 *
 * Affordability is judged against the mana a player **could** produce, not what is already floating
 * in their pool. Nobody taps five lands and then decides what to cast; they pick the spell and the
 * mana follows. Showing a card as uncastable because the lands are still untapped would be
 * technically true and useless.
 */
import { zoneKey } from './cards.js';
import { listAt } from './cardActions.js';
import { characteristicsOf } from './characteristics.js';
import { atSorcerySpeed, bottomOwed, pendingDeclaration, stackTop } from './automation.js';
import { legalAttackers, legalBlockers, canBlock } from './combat.js';
import { poolOf } from './effects.js';
import { addMana, canPay, parseManaCost, type ManaPool, type ManaType } from './mana.js';
import { scriptFor } from './scripts.js';
import type { AbilityDef, CardScript, TargetSpec } from './scriptTypes.js';
import { legalTargets } from './targeting.js';
import { MAIN_STEPS, type Step, type Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/** One thing a player could do, with everything the UI needs to offer it. */
export interface LegalPlay {
  readonly kind: 'land' | 'cast' | 'activate';
  readonly card: string;
  readonly name: string;
  readonly description: string;
  readonly manaCost: string;
  readonly abilityIndex?: number;
  /** What must be chosen, in order. Empty when the play needs no targets. */
  readonly targetSpecs: readonly TargetSpec[];
  /** Legal candidates for each spec, in the same order. */
  readonly candidates: readonly (readonly Target[])[];
  /** A mana ability resolves immediately, which the UI shows differently. */
  readonly isManaAbility: boolean;
}

export interface BlockOption {
  readonly blocker: string;
  readonly name: string;
  /** Attackers this creature may legally block. */
  readonly canBlock: readonly string[];
}

export interface LegalActions {
  readonly seat: SeatIndex;
  readonly step: Step;
  readonly hasPriority: boolean;
  readonly isActivePlayer: boolean;
  readonly canPass: boolean;
  /** What passing would do next, so the button can say "Resolve" or "Next step". */
  readonly passLabel: string;
  readonly plays: readonly LegalPlay[];
  /** Set during declare attackers, when this seat is the attacking player. */
  readonly attackers: readonly string[];
  /** Set during declare blockers, when this seat is being attacked. */
  readonly blockers: readonly BlockOption[];
  /** How many cards still have to be discarded to hand size. */
  readonly mustDiscard: number;
  /**
   * Set while this seat is deciding on its opening hand: how many cards it owes the bottom of its
   * library if it keeps now. Zero is a perfectly good answer — it means "keep a fresh seven".
   */
  readonly mustSettleHand: boolean;
  readonly bottomOwed: number;
  /**
   * A declaration this seat owes before play continues. Separate from `hasPriority` because
   * declaring attackers or blockers is a turn-based action, so the seat that owes one holds no
   * priority — a UI keyed on priority alone would show the defender nothing to do.
   */
  readonly mustDeclare: 'attackers' | 'blockers' | null;
  /** Mana floating right now. */
  readonly pool: ManaPool;
  /** Mana that could still be produced from untapped permanents. */
  readonly potential: ManaPool;
}

/** Mana the seat could add to its pool without casting anything. */
export function potentialMana(state: GameState, seat: SeatIndex): ManaPool {
  let pool = poolOf(state, seat);
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    for (const ability of script?.abilities ?? []) {
      if (ability.produces === undefined) continue;
      if (ability.cost.tap) {
        // A creature's tap ability is unavailable while it is summoning sick.
        if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      }
      // Only free mana abilities count towards what is reachable; one that costs mana would need
      // the mana first, and pretending otherwise would offer spells that cannot be cast.
      if (ability.cost.mana) continue;
      for (const type of ability.produces) pool = addMana(pool, type as ManaType, 1);
    }
  }
  return pool;
}

const specsFor = (script: CardScript | undefined): readonly TargetSpec[] =>
  script?.targets ?? (script?.aura ? [script.aura.target] : []);

function playableTargets(
  state: GameState, specs: readonly TargetSpec[], seat: SeatIndex,
): { ok: boolean; candidates: Target[][] } {
  const candidates = specs.map((spec) => legalTargets(state, spec, seat));
  const ok = specs.every((spec, i) => spec.optional || (candidates[i]?.length ?? 0) > 0);
  return { ok, candidates };
}

function castablePlays(state: GameState, seat: SeatIndex, potential: ManaPool): LegalPlay[] {
  const out: LegalPlay[] = [];
  const sorcerySpeed = atSorcerySpeed(state, seat);
  const landsPlayed = state.landsPlayed[String(seat)] ?? 0;

  for (const id of listAt(state, zoneKey(seat, 'hand'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const def = state.cardDefs[inst.defKey];
    const ch = characteristicsOf(state, inst);
    const script = scriptFor(def?.name);

    if (ch.isLand) {
      if (sorcerySpeed && landsPlayed < 1) {
        out.push({
          kind: 'land', card: id, name: ch.name, description: `Play ${ch.name}`,
          manaCost: '', targetSpecs: [], candidates: [], isManaAbility: false,
        });
      }
      continue;
    }

    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant') || ch.keywords.has('flash');
    if (!instantSpeed && !sorcerySpeed) continue;

    const cost = parseManaCost(def?.manaCost);
    if (cost.unsupported !== undefined) continue;
    if (!canPay(potential, cost)) continue;

    const specs = specsFor(script);
    const { ok, candidates } = playableTargets(state, specs, seat);
    if (!ok) continue;

    out.push({
      kind: 'cast', card: id, name: ch.name, description: `Cast ${ch.name}`,
      manaCost: def?.manaCost ?? '', targetSpecs: specs, candidates, isManaAbility: false,
    });
  }
  return out;
}

function activatablePlays(state: GameState, seat: SeatIndex, potential: ManaPool): LegalPlay[] {
  const out: LegalPlay[] = [];
  const sorcerySpeed = atSorcerySpeed(state, seat);

  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities: readonly AbilityDef[] = script?.abilities ?? [];

    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if (ability.sorcerySpeed && !sorcerySpeed) continue;
      if (ability.cost.tap) {
        if (inst.tapped) continue;
        if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      }
      if (ability.cost.mana && !canPay(potential, parseManaCost(ability.cost.mana))) continue;

      const specs = ability.targets ?? [];
      const { ok, candidates } = playableTargets(state, specs, seat);
      if (!ok) continue;

      out.push({
        kind: 'activate', card: id, name: ch.name, description: ability.description,
        manaCost: ability.cost.mana ?? '', abilityIndex: i,
        targetSpecs: specs, candidates, isManaAbility: ability.produces !== undefined,
      });
    }
  }
  return out;
}

/** Everything `seat` may do in the current state. */
export function legalActions(state: GameState, seat: SeatIndex): LegalActions {
  const hasPriority = state.automated && state.priority === seat;
  const potential = potentialMana(state, seat);
  const pending = state.pendingDiscard;
  const mustDiscard = pending !== null && pending.seat === seat ? pending.count : 0;
  const owed = pendingDeclaration(state);
  const mustDeclare = owed !== null && owed.seats.includes(seat) ? owed.kind : null;
  const mustSettleHand = state.automated && state.openingHands && !state.kept.includes(seat)
    && state.seats[seat]?.eliminated === false;

  const empty: LegalActions = {
    seat, step: state.step, hasPriority, isActivePlayer: state.activeSeat === seat,
    canPass: false, passLabel: '', plays: [], attackers: [], blockers: [],
    mustDiscard, mustDeclare, mustSettleHand, bottomOwed: bottomOwed(state, seat),
    pool: poolOf(state, seat), potential,
  };
  if (!state.automated || state.finished) return empty;
  // Opening hands come before anything else, including priority.
  if (state.openingHands) return mustSettleHand ? { ...empty, passLabel: 'Keep' } : empty;
  if (mustDiscard > 0) return { ...empty, passLabel: `Discard ${mustDiscard}` };
  // A declaration comes before priority, so it is offered to the seat that owes it even though
  // nobody holds priority while it is outstanding.
  if (mustDeclare === 'attackers') {
    return { ...empty, passLabel: 'Declare attackers', attackers: legalAttackers(state, seat) };
  }
  if (mustDeclare === 'blockers') return { ...empty, passLabel: 'Declare blockers', blockers: blockOptions(state, seat) };
  if (!hasPriority) return empty;

  const top = stackTop(state);
  const othersPassed = state.passed.length >= state.seats.filter((s) => !s.eliminated).length - 1;
  const passLabel = top !== undefined
    ? othersPassed ? `Resolve ${top.description}` : 'Pass'
    : othersPassed ? 'Next step' : 'Pass';

  const plays = [...castablePlays(state, seat, potential), ...activatablePlays(state, seat, potential)];

  return { ...empty, canPass: true, passLabel, plays, attackers: [], blockers: [] };
}

/** Every creature this seat may block with, and which attackers each one may be assigned to. */
function blockOptions(state: GameState, seat: SeatIndex): BlockOption[] {
  return legalBlockers(state, seat).map((id) => ({
    blocker: id,
    name: characteristicsOf(state, state.instances[id]!).name,
    canBlock: state.combat.attacks
      .filter((a) => a.defender === seat && canBlock(state, id, a.attacker, seat) === null)
      .map((a) => a.attacker),
  }));
}

export { MAIN_STEPS };
