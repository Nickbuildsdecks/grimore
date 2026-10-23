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
import {
  atSorcerySpeed, bottomOwed, modeCombinations, modeTargetSpecs, modesOf, pendingDeclaration,
  sacrificeOptions, stackTop,
} from './automation.js';
import { legalAttackers, legalBlockers, canBlock } from './combat.js';
import { poolOf } from './effects.js';
import { addMana, canPay, maxX, parseManaCost, type ManaCost, type ManaPool, type ManaType } from './mana.js';
import { scriptFor } from './scripts.js';
import type { AbilityDef, CardScript, TargetSpec } from './scriptTypes.js';
import { legalTargets } from './targeting.js';
import { MAIN_STEPS, type DecisionZone, type Step, type Target } from './turnTypes.js';
import type { GameState, SeatIndex } from './types.js';

/** One thing a player could do, with everything the UI needs to offer it. */
export interface LegalPlay {
  readonly kind: 'land' | 'cast' | 'activate';
  readonly card: string;
  readonly name: string;
  readonly description: string;
  readonly manaCost: string;
  /**
   * The commander tax on this cast, in generic mana, or absent when there is none.
   *
   * Separate from `manaCost` because the cost printed on the card has not changed — the tax is
   * what the command zone adds (CR 903.8), and a table that showed `{3}{B}{G}` as the cost of a
   * four-mana commander on its third cast would be lying about the card.
   */
  readonly commanderTax?: number;
  /**
   * The largest X this seat could pay for, for a cost with {X} in it, and absent for every other
   * play.
   *
   * Reported rather than left to the client because what X can be is a mana question, and the
   * client has no business re-deriving one: a table that offered an X it could not pay for would
   * be offering a play the engine then refuses. X is chosen as the spell is cast (CR 601.2b),
   * which is why it travels on the play and not into the resolution.
   */
  readonly xMax?: number;
  readonly abilityIndex?: number;
  /**
   * For a modal spell: which modes this play takes, as indices into the script's `modal.modes`.
   *
   * One play per legal combination, which is why the table needed no new interface for modal
   * spells — it already offers several plays for one card when a permanent has several abilities.
   */
  readonly modes?: readonly number[];
  /** What must be chosen, in order. Empty when the play needs no targets. */
  readonly targetSpecs: readonly TargetSpec[];
  /** Legal candidates for each spec, in the same order. */
  readonly candidates: readonly (readonly Target[])[];
  /** A mana ability resolves immediately, which the UI shows differently. */
  readonly isManaAbility: boolean;
  /**
   * Creatures that could be sacrificed to pay for this, when its cost asks for one. Empty for
   * everything else — a cost is paid as the ability is activated, so the choice travels with the
   * play rather than being asked for afterwards.
   */
  readonly sacrificeOptions: readonly string[];
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
   * A triggered ability of this seat's that is waiting for its targets, with the candidates for
   * each. Null when there is nothing to choose.
   */
  readonly mustChoose: {
    readonly description: string;
    readonly specs: readonly TargetSpec[];
    readonly candidates: readonly (readonly Target[])[];
  } | null;
  /**
   * A question a card asked this seat while it was resolving, with the cards it may choose between.
   *
   * Per-seat for a reason that is not cosmetic: the candidates for a library search are cards in a
   * hidden zone, so they travel in `you` — which `viewFor` only ever builds for the seat it is
   * addressed to — and never in the public part of the view.
   */
  readonly mustDecide: {
    readonly prompt: string;
    readonly from: DecisionZone;
    readonly candidates: readonly string[];
    readonly min: number;
    readonly max: number;
  } | null;
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
  state: GameState, specs: readonly TargetSpec[], seat: SeatIndex, source?: string,
): { ok: boolean; candidates: Target[][] } {
  const candidates = specs.map((spec) => legalTargets(state, spec, seat, source));
  const ok = specs.every((spec, i) => spec.optional || (candidates[i]?.length ?? 0) > 0);
  return { ok, candidates };
}

function castablePlays(state: GameState, seat: SeatIndex, potential: ManaPool): LegalPlay[] {
  const out: LegalPlay[] = [];
  const sorcerySpeed = atSorcerySpeed(state, seat);
  const landsPlayed = state.landsPlayed[String(seat)] ?? 0;
  const tax = state.seats[seat]?.commanderTax ?? 0;

  // A commander is cast from the command zone, which is why it is a second list rather than part
  // of the hand. Without this the engine never offered a commander at all — in a format whose
  // whole point is the commander.
  const castable = [
    ...listAt(state, zoneKey(seat, 'hand')).map((id) => ({ id, fromCommand: false })),
    ...listAt(state, zoneKey(seat, 'command')).map((id) => ({ id, fromCommand: true })),
  ];

  for (const { id, fromCommand } of castable) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const def = state.cardDefs[inst.defKey];
    const ch = characteristicsOf(state, inst);
    const script = scriptFor(def?.name);

    if (ch.isLand) {
      // A land commander would be *played*, not cast, and nothing in the pool is one; refusing to
      // offer it is better than offering a land drop out of the command zone.
      if (fromCommand) continue;
      if (sorcerySpeed && landsPlayed < 1) {
        out.push({
          kind: 'land', card: id, name: ch.name, description: `Play ${ch.name}`,
          manaCost: '', targetSpecs: [], candidates: [], isManaAbility: false, sacrificeOptions: [],
        });
      }
      continue;
    }

    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant') || ch.keywords.has('flash');
    if (!instantSpeed && !sorcerySpeed) continue;

    const printed = parseManaCost(def?.manaCost);
    if (printed.unsupported !== undefined) continue;
    // The tax is generic mana on top of the printed cost (CR 903.8), and it only applies to a
    // cast from the command zone.
    const cost: ManaCost = fromCommand && tax > 0
      ? { ...printed, generic: printed.generic + tax }
      : printed;
    if (!canPay(potential, cost)) continue;
    const taxOn = fromCommand && tax > 0 ? { commanderTax: tax } : {};
    // X at zero is a legal cast of an X spell and sometimes the only one available, so a cost with
    // {X} is offered whenever the rest of it can be paid; `xMax` says how high the player may go.
    const xOn = cost.x ? { xMax: maxX(potential, cost) } : {};

    // A modal spell is offered once per legal combination of modes, and a combination whose
    // targets cannot be filled is not offered at all — so "destroy target creature; or draw two
    // cards" offers only the draw when the board is empty.
    const combinations = modeCombinations(script);
    if (combinations.length > 0) {
      for (const modes of combinations) {
        const chosen = modesOf(script, modes);
        const specs = modeTargetSpecs(chosen);
        const { ok, candidates } = playableTargets(state, specs, seat, id);
        if (!ok) continue;
        out.push({
          kind: 'cast', card: id, name: ch.name,
          description: `Cast ${ch.name} — ${chosen.map((m) => m.description).join('; and ')}`,
          manaCost: def?.manaCost ?? '', ...taxOn, ...xOn, modes, targetSpecs: specs, candidates,
          isManaAbility: false, sacrificeOptions: [],
        });
      }
      continue;
    }

    const specs = specsFor(script);
    const { ok, candidates } = playableTargets(state, specs, seat, id);
    if (!ok) continue;

    out.push({
      kind: 'cast', card: id, name: ch.name,
      description: fromCommand && tax > 0 ? `Cast ${ch.name} (+{${tax}} tax)` : `Cast ${ch.name}`,
      manaCost: def?.manaCost ?? '', ...taxOn, ...xOn, targetSpecs: specs, candidates,
      isManaAbility: false, sacrificeOptions: [],
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
      // An ability whose cost is a sacrifice is not activatable with nothing to sacrifice.
      const victims = sacrificeOptions(state, seat, id, ability.cost);
      if (ability.cost.sacrifice !== undefined && victims.length === 0) continue;

      const specs = ability.targets ?? [];
      const { ok, candidates } = playableTargets(state, specs, seat, id);
      if (!ok) continue;

      out.push({
        kind: 'activate', card: id, name: ch.name, description: ability.description,
        manaCost: ability.cost.mana ?? '', abilityIndex: i,
        targetSpecs: specs, candidates, isManaAbility: ability.produces !== undefined,
        sacrificeOptions: victims,
      });
    }
  }
  return out;
}

/** Everything `seat` may do in the current state. */
export function legalActions(state: GameState, seat: SeatIndex): LegalActions {
  /**
   * Holding priority, which is not the same as being named in `state.priority`.
   *
   * Everything that blocks the game is listed, and the list is belt-and-braces on purpose: the
   * engine clears `priority` when it stops to ask, but the consequence of forgetting to is a table
   * that offers a pass the engine refuses *every time*, for as long as the question stands — a
   * stuck game rather than a wrong label. One of the two has to be hard to get wrong, and this is
   * the one the client actually reads.
   */
  const hasPriority = state.automated && state.priority === seat
    && !state.openingHands && state.pendingDecision === null && state.pendingChoice === null
    && state.pendingDiscard === null && pendingDeclaration(state) === null;
  const potential = potentialMana(state, seat);
  const pending = state.pendingDiscard;
  const mustDiscard = pending !== null && pending.seat === seat ? pending.count : 0;
  const owed = pendingDeclaration(state);
  const mustDeclare = owed !== null && owed.seats.includes(seat) ? owed.kind : null;
  const mustSettleHand = state.automated && state.openingHands && !state.kept.includes(seat)
    && state.seats[seat]?.eliminated === false;

  const choice = state.pendingChoice;
  let mustChoose: LegalActions['mustChoose'] = null;
  if (choice !== null && choice.seat === seat) {
    const object = state.stackObjects[choice.stackId];
    const script = object === undefined ? undefined : scriptFor(state.cardDefs[object.cardKey]?.name);
    const specs = (object?.abilityIndex === undefined
      ? []
      : object.kind === 'activated'
        ? script?.abilities?.[object.abilityIndex]?.targets
        : script?.triggers?.[object.abilityIndex]?.targets) ?? [];
    mustChoose = {
      description: choice.description,
      specs,
      candidates: specs.map((spec) => legalTargets(state, spec, seat)),
    };
  }

  const decision = state.pendingDecision;
  const mustDecide: LegalActions['mustDecide'] = decision !== null && decision.seat === seat
    ? {
        prompt: decision.prompt, from: decision.from,
        candidates: decision.candidates, min: decision.min, max: decision.max,
      }
    : null;

  const empty: LegalActions = {
    seat, step: state.step, hasPriority, isActivePlayer: state.activeSeat === seat,
    canPass: false, passLabel: '', plays: [], attackers: [], blockers: [],
    mustDiscard, mustDeclare, mustSettleHand, bottomOwed: bottomOwed(state, seat), mustChoose,
    mustDecide, pool: poolOf(state, seat), potential,
  };
  if (!state.automated || state.finished) return empty;
  // Opening hands come before anything else, including priority.
  if (state.openingHands) return mustSettleHand ? { ...empty, passLabel: 'Keep' } : empty;
  // So does a trigger waiting for its targets: nothing else can happen until it has them.
  if (choice !== null) return mustChoose === null ? empty : { ...empty, passLabel: 'Choose a target' };
  // And so does a spell that stopped mid-resolution to ask somebody a question. It is still on the
  // stack; nobody holds priority until it is answered, including the player who cast it.
  if (decision !== null) return mustDecide === null ? empty : { ...empty, passLabel: 'Choose' };
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
