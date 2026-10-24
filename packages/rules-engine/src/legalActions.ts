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
import {
  canBlock, damageOrdersOwed, forcedAttackers, legalAttackers, legalBlockers, legalDefenders,
} from './combat.js';
import { poolOf } from './effects.js';
import {
  addMana, canAfford, maxAffordableX, parseManaCost,
  type ManaCost, type ManaPool, type ManaType,
} from './mana.js';
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
   * Set on an ability used from the hand rather than from the battlefield — cycling, and nothing
   * else so far. The table needs it because a card in hand is drawn in a different row and a play
   * on it is not "use this permanent".
   */
  readonly fromHand?: boolean;
  /** Set on the second of the two plays a kicker offers: this one pays it (CR 702.32a). */
  readonly kicked?: boolean;
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
  /**
   * Of those, the ones that have no choice: "attacks each combat if able" (CR 508.1d).
   *
   * Read by the table so it can say so rather than letting a player build a declaration the engine
   * then refuses — the same reason `blocked` exists for cards in hand. Empty whenever there is
   * nobody left to attack, because then nothing is able.
   */
  readonly mustAttack: readonly string[];
  /**
   * Per creature that may attack, the defenders it may legally be aimed at — goad's restriction,
   * made into something a table can draw.
   *
   * Only the creatures whose answer is *not* "every live opponent" appear, because that is the
   * ordinary case and a list repeating it for every creature in a four-seat pod is three times the
   * wire traffic to say nothing. An absent card means no aim of it is banned.
   */
  readonly attackAims: readonly { readonly card: string; readonly defenders: readonly SeatIndex[] }[];
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
  readonly mustDeclare: 'attackers' | 'blockers' | 'order' | null;
  /**
   * The damage assignment order this seat owes (CR 509.2): per attacking creature of theirs, the
   * blockers to put in order. Empty unless `mustDeclare` is `'order'`.
   *
   * Carried here rather than worked out by the table for the usual reason — the question is only
   * asked when the order can change which blockers die, and that is a rules judgement.
   */
  readonly mustOrder: readonly { readonly attacker: string; readonly blockers: readonly string[] }[];
  /**
   * Why each card this seat holds is *not* playable, for the ones that are not.
   *
   * The table could work most of these out — it knows the step and the pool — but not all of them
   * (a spell with no legal target looks exactly like a spell you cannot afford), and a second
   * implementation of "can this be cast" is the one thing `legalActions` exists to prevent. Every
   * `continue` in `castablePlays` is a reason; this is that list, said in words.
   *
   * Cards in hand and in the command zone only. An ability missing from a permanent's list is a
   * different question and is not answered here.
   */
  readonly blocked: readonly { readonly card: string; readonly reason: string }[];
  /** Mana floating right now. */
  readonly pool: ManaPool;
  /** Mana that could still be produced from untapped permanents. */
  readonly potential: ManaPool;
}

/** Mana the seat could add to its pool without casting anything. */
/** One permanent the engine may tap for mana, and what tapping it would cost and add. */
interface ManaSourceEntry {
  readonly key: string;
  readonly produces: readonly ManaType[];
  readonly abilityIndex: number;
  readonly choose?: boolean;
  /** Life the tap costs, for a land that charges you for the colour. */
  readonly life?: number;
}

/**
 * Permanents the engine may tap on a player's behalf to pay a cost.
 *
 * Only abilities that need nothing the seat does not already have: one that costs mana would need
 * mana first, and pretending otherwise offers spells that cannot be cast. One entry per permanent,
 * because tapping it is what pays — and several tap-for-mana abilities on one permanent are a
 * *choice* between them rather than a sum, which is exactly what a dual land is.
 *
 * A life cost is the one non-mana cost that counts, because it is the one a seat can always decide
 * about from its own life total. Mana Confluence was a dead land for as long as this function only
 * admitted a bare tap: it never paid for a spell, never showed up in the dimmed pips, and the
 * engine would refuse a cast that the player could see the mana for. Painful sources go last in
 * the list so the solver's tie-breaks — every one of which keeps the first source it found —
 * reach for a Swamp before they reach for your life total.
 *
 * Lives here rather than in `automation.ts` because `legalActions` is what asks it the question
 * that matters — "can this be paid for at all" — and `automation.ts` already imports this file.
 */
export function manaSources(state: GameState, seat: SeatIndex): ManaSourceEntry[] {
  const free: ManaSourceEntry[] = [];
  const painful: ManaSourceEntry[] = [];
  const life = state.seats[seat]?.life ?? 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities = script?.abilities ?? [];
    let usable: { index: number; produces: readonly ManaType[]; life: number }[] = [];
    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if (ability.produces === undefined || ability.produces.length === 0) continue;
      if (ability.cost.mana !== undefined) continue;
      if (!ability.cost.tap) continue;
      if (ability.cost.sacrificeSelf) continue;
      if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      // A cost you cannot pay is not a cost you may pay (CR 118.4) — and paying down to nothing
      // is a legal way to lose the game, so the engine stops one short of it.
      const cost = ability.cost.life ?? 0;
      if (cost > 0 && life <= cost) continue;
      usable.push({ index: i, produces: ability.produces as readonly ManaType[], life: cost });
    }
    // A permanent with both a free tap and a paid one keeps only the free ones. No scripted card
    // is shaped that way; if one ever is, the conservative half of it is the half to offer, since
    // charging life for a tap that did not need it is the one mistake that cannot be taken back.
    if (usable.some((u) => u.life === 0)) usable = usable.filter((u) => u.life === 0);
    if (usable.length === 0) continue;
    const cost = usable[0]!.life;
    const bucket = cost > 0 ? painful : free;
    // One source per permanent, because tapping it is what pays — and several tap abilities on
    // one permanent are a *choice* between them, not a sum. That is what a dual land is: two
    // abilities, one tap, one mana. Treating them as a sum would offer spells nobody can cast.
    if (usable.length === 1) {
      bucket.push({
        key: id, produces: usable[0]!.produces, abilityIndex: usable[0]!.index,
        ...(cost > 0 ? { life: cost } : {}),
      });
      continue;
    }
    bucket.push({
      key: id,
      produces: usable.flatMap((u) => u.produces),
      abilityIndex: usable[0]!.index,
      choose: true,
      ...(cost > 0 ? { life: cost } : {}),
    });
  }
  return [...free, ...painful];
}

/** The sources `legalActions` asks about affordability, as `manaSources` reports them. */
type ManaSources = ReturnType<typeof manaSources>;

/**
 * The mana a seat could still make, for the dimmed pips on the control bar.
 *
 * Optimistic on purpose, and only ever shown: a dual land counts once for each colour it could
 * make, because "you could make U or B" is what a player wants to read off it. Nothing decides
 * what is castable from this — that is `canAfford`, which asks the solver — and the two were one
 * answer until a land existed that could make either of two colours but only one of them.
 */
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
      // A life cost is reachable while there is life to pay it with. Shown rather than hidden,
      // because a player looking at Mana Confluence already counts it as a land.
      const life = ability.cost.life ?? 0;
      if (life > 0 && (state.seats[seat]?.life ?? 0) <= life) continue;
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

interface Castable {
  readonly plays: LegalPlay[];
  /** Why a card produced no play, in the player's words. First reason met wins. */
  readonly blocked: { card: string; reason: string }[];
}

function castablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): Castable {
  const out: LegalPlay[] = [];
  const blocked: { card: string; reason: string }[] = [];
  /** Records the first reason a card gave, so a later one does not overwrite the real cause. */
  const why = (card: string, reason: string): void => {
    if (!blocked.some((entry) => entry.card === card)) blocked.push({ card, reason });
  };
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
      } else if (!sorcerySpeed) {
        why(id, 'a land is played in your own main phase, with nothing on the stack');
      } else {
        why(id, 'you have already played a land this turn');
      }
      continue;
    }

    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant') || ch.keywords.has('flash');
    if (!instantSpeed && !sorcerySpeed) {
      why(id, 'sorcery speed: your own main phase, with nothing on the stack');
      continue;
    }

    const printed = parseManaCost(def?.manaCost);
    if (printed.unsupported !== undefined) {
      why(id, 'this cost is not one the engine can pay — move it by hand');
      continue;
    }
    /*
      An additional cost that is not optional (CR 601.2h): a spell asking for a creature to
      sacrifice is not castable with no creature to sacrifice, so it is not offered at all. The
      victims travel on the play, the way they already do for an activated ability's cost — the
      choice is part of casting it, not a question asked afterwards.
    */
    const victims = script?.additionalCost === undefined
      ? []
      : sacrificeOptions(state, seat, id, { sacrifice: script.additionalCost.sacrifice });
    if (script?.additionalCost !== undefined && victims.length === 0) {
      why(id, script.additionalCost.sacrifice === 'another-creature'
        ? 'it asks for another creature to sacrifice, and you have none'
        : 'it asks for a creature to sacrifice, and you have none');
      continue;
    }
    // The tax is generic mana on top of the printed cost (CR 903.8), and it only applies to a
    // cast from the command zone.
    const cost: ManaCost = fromCommand && tax > 0
      ? { ...printed, generic: printed.generic + tax }
      : printed;
    if (!canAfford(poolOf(state, seat), cost, sources)) {
      why(id, 'not enough mana, counting every land you could still tap');
      continue;
    }
    const taxOn = fromCommand && tax > 0 ? { commanderTax: tax } : {};
    // X at zero is a legal cast of an X spell and sometimes the only one available, so a cost with
    // {X} is offered whenever the rest of it can be paid; `xMax` says how high the player may go.
    const xOn = cost.x ? { xMax: maxAffordableX(poolOf(state, seat), cost, sources) } : {};

    // A modal spell is offered once per legal combination of modes, and a combination whose
    // targets cannot be filled is not offered at all — so "destroy target creature; or draw two
    // cards" offers only the draw when the board is empty.
    const combinations = modeCombinations(script);
    if (combinations.length > 0) {
      for (const modes of combinations) {
        const chosen = modesOf(script, modes);
        const specs = modeTargetSpecs(chosen);
        const { ok, candidates } = playableTargets(state, specs, seat, id);
        if (!ok) {
          why(id, 'no legal target for any of its modes');
          continue;
        }
        out.push({
          kind: 'cast', card: id, name: ch.name,
          description: `Cast ${ch.name} — ${chosen.map((m) => m.description).join('; and ')}`,
          manaCost: def?.manaCost ?? '', ...taxOn, ...xOn, modes, targetSpecs: specs, candidates,
          isManaAbility: false, sacrificeOptions: victims,
        });
      }
      continue;
    }

    const specs = specsFor(script);
    const { ok, candidates } = playableTargets(state, specs, seat, id);
    if (!ok) {
      why(id, 'nothing it could legally target');
      continue;
    }

    out.push({
      kind: 'cast', card: id, name: ch.name,
      description: fromCommand && tax > 0 ? `Cast ${ch.name} (+{${tax}} tax)` : `Cast ${ch.name}`,
      manaCost: def?.manaCost ?? '', ...taxOn, ...xOn, targetSpecs: specs, candidates,
      isManaAbility: false, sacrificeOptions: victims,
    });

    /*
      Kicker: a second play, offered only when the whole thing can be paid for.

      One play per option, which is why a kicker needed no new interface — the same shape that
      offers a modal spell once per combination of modes offers this card twice, and a player who
      cannot afford the kicker simply never sees the second one. The kicker's symbols are appended
      to the printed cost rather than paid separately, so a coloured kicker is checked as part of
      one cost and a player who could pay half of it is offered neither half.
    */
    const kicker = script?.kicker;
    if (kicker !== undefined) {
      const withKicker = parseManaCost(`${def?.manaCost ?? ''}${kicker.cost}`);
      const kickedCost: ManaCost = fromCommand && tax > 0
        ? { ...withKicker, generic: withKicker.generic + tax }
        : withKicker;
      if (withKicker.unsupported === undefined && canAfford(poolOf(state, seat), kickedCost, sources)) {
        out.push({
          kind: 'cast', card: id, name: ch.name, kicked: true,
          description: `Cast ${ch.name} with ${kicker.description.toLowerCase()}`,
          manaCost: `${def?.manaCost ?? ''}${kicker.cost}`, ...taxOn,
          ...(kickedCost.x ? { xMax: maxAffordableX(poolOf(state, seat), kickedCost, sources) } : {}),
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: victims,
        });
      }
    }
  }
  return { plays: out, blocked };
}

function activatablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): LegalPlay[] {
  const out: LegalPlay[] = [];
  const sorcerySpeed = atSorcerySpeed(state, seat);

  /*
    The battlefield, and the hand.

    Almost every activated ability is used from the battlefield; cycling is used from the hand and
    pays for itself by being discarded (CR 702.29a). Rather than a second loop that would drift
    from this one, both zones are walked and each ability is skipped unless it is in the zone its
    own cost implies — so a land's `{T}: add {B}` is not offered while the land is in hand, and its
    cycling is not offered once the land is on the battlefield.
  */
  const reachable = [
    ...listAt(state, zoneKey(seat, 'battlefield')).map((id) => ({ id, inHand: false })),
    ...listAt(state, zoneKey(seat, 'hand')).map((id) => ({ id, inHand: true })),
  ];

  for (const { id, inHand } of reachable) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities: readonly AbilityDef[] = script?.abilities ?? [];

    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if ((ability.cost.discardSelf === true) !== inHand) continue;
      if (ability.sorcerySpeed && !sorcerySpeed) continue;
      /*
        A loyalty ability: sorcery speed, one per planeswalker per turn (CR 606.3), and a minus
        that cannot be paid for is not an option at all. All three are implied by the cost being
        a loyalty cost — every loyalty ability in the game has them — so a script says `-3` and
        gets the rules with it.
      */
      if (ability.cost.loyalty !== undefined) {
        if (!sorcerySpeed) continue;
        if (inst.loyaltyUsedTurn === state.turn) continue;
        const loyalty = inst.counters['loyalty'] ?? 0;
        if (loyalty + ability.cost.loyalty < 0) continue;
      }
      if (ability.cost.tap) {
        if (inst.tapped) continue;
        if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      }
      if (ability.cost.mana
        && !canAfford(poolOf(state, seat), parseManaCost(ability.cost.mana), sources)) continue;
      // Life is a cost like any other: an ability you cannot pay for is not offered, which is why
      // a Mana Confluence stops making mana at one life and a City of Brass does not.
      if (ability.cost.life !== undefined && (state.seats[seat]?.life ?? 0) <= ability.cost.life) continue;
      // An ability whose cost is a sacrifice is not activatable with nothing to sacrifice.
      const victims = sacrificeOptions(state, seat, id, ability.cost);
      if (ability.cost.sacrifice !== undefined && victims.length === 0) continue;

      const specs = ability.targets ?? [];
      const { ok, candidates } = playableTargets(state, specs, seat, id);
      if (!ok) continue;

      out.push({
        kind: 'activate', card: id, name: ch.name, description: ability.description,
        manaCost: ability.cost.mana ?? '', abilityIndex: i,
        ...(inHand ? { fromHand: true } : {}),
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
  // What could still be tapped, which is what decides affordability. `potential` above is the
  // same question answered loosely for the *display*, and the two part company over a dual land:
  // one source, one mana, two colours it might be.
  const sources = manaSources(state, seat);
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
      /*
        With the source, which it was missing.

        Every filter that says "another" reads the source to know which candidate is itself, and
        without it this list offered the ability's own permanent as a target — while
        `chooseTargets` in the engine, which does pass it, refused the choice. A table offering
        something the engine then refuses is the one bug class this file exists to prevent, and it
        went unnoticed until a card with "another target nonland permanent" existed to show it.
      */
      candidates: specs.map((spec) => legalTargets(state, spec, seat, object?.source)),
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
    canPass: false, passLabel: '', plays: [], attackers: [], mustAttack: [], attackAims: [],
    blockers: [], mustOrder: [],
    mustDiscard, mustDeclare, mustSettleHand, bottomOwed: bottomOwed(state, seat), mustChoose,
    mustDecide, blocked: [], pool: poolOf(state, seat), potential,
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
    const attackers = legalAttackers(state, seat);
    const live = state.seats.filter((s) => s.index !== seat && !s.eliminated).map((s) => s.index);
    return {
      ...empty,
      passLabel: 'Declare attackers',
      attackers,
      mustAttack: live.length > 0 ? forcedAttackers(state, seat) : [],
      attackAims: attackers
        .map((card) => ({ card, defenders: legalDefenders(state, card, seat) }))
        .filter((entry) => entry.defenders.length !== live.length),
    };
  }
  if (mustDeclare === 'blockers') return { ...empty, passLabel: 'Declare blockers', blockers: blockOptions(state, seat) };
  if (mustDeclare === 'order') {
    return { ...empty, passLabel: 'Assign damage', mustOrder: damageOrdersOwed(state, seat) };
  }
  if (!hasPriority) return empty;

  const top = stackTop(state);
  const othersPassed = state.passed.length >= state.seats.filter((s) => !s.eliminated).length - 1;
  const passLabel = top !== undefined
    ? othersPassed ? `Resolve ${top.description}` : 'Pass'
    : othersPassed ? 'Next step' : 'Pass';

  const casts = castablePlays(state, seat, sources);
  const plays = [...casts.plays, ...activatablePlays(state, seat, sources)];
  // A card with a play is not blocked, whatever else was tried: a modal spell whose first mode
  // has no target is still castable for the mode that does.
  const playable = new Set(plays.map((play) => play.card));
  const blocked = casts.blocked.filter((entry) => !playable.has(entry.card));

  return {
    ...empty, canPass: true, passLabel, plays, blocked,
    attackers: [], mustAttack: [], attackAims: [], blockers: [], mustOrder: [],
  };
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
