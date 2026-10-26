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
import { isFaceDownPermanent, zoneKey } from './cards.js';
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
import {
  FORETELL_COST, MORPH_COST, morphCostText,
  type AbilityDef, type CardScript, type TargetSpec,
} from './scriptTypes.js';
import { legalTargets } from './targeting.js';
import { PACT_KINDS } from './pacts.js';
import { MAIN_STEPS, type DecisionZone, type Step, type Target } from './turnTypes.js';
import type { GameState, PactKind, SeatIndex } from './types.js';

/** One thing a player could do, with everything the UI needs to offer it. */
export interface LegalPlay {
  /**
   * `turnUp` is the odd one: a special action rather than a cast or an ability (CR 702.37b), which
   * is exactly why it is its own kind — it uses no stack, so a table that drew it as an ability
   * would be promising a window to respond that does not exist.
   */
  readonly kind: 'land' | 'cast' | 'activate' | 'turnUp' | 'foretell';
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
   * Set on a play that casts the card out of its owner's graveyard for its flashback cost
   * (CR 702.33).
   *
   * A separate play rather than a flag on the hand's one, for the same reason the kicker is: the
   * table draws it in a different row — the graveyard — and the cost shown is not the printed one.
   */
  readonly flashback?: boolean;
  /**
   * Set on the play that casts a morph card face down as a 2/2 for {3} (CR 702.37a).
   *
   * A second play on the same card, like the kicker's, rather than a flag the table has to combine
   * with something: the cost shown is {3} and nothing on the card, and the two plays are offered
   * independently — a morph you cannot pay the printed cost for still offers this one.
   */
  readonly faceDown?: boolean;
  /**
   * Set on the play that casts a foretold card out of exile for its foretell cost (CR 702.143b).
   *
   * A different *zone* as well as a different cost, which is the half that bites: without the flag
   * the engine is told to cast a card in exile as though it were in hand, and refuses the play the
   * table had just offered. Flashback taught that lesson in a browser suite.
   */
  readonly foretold?: boolean;
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
    /** Absent when the answer is a word rather than a card. See `options`. */
    readonly from?: DecisionZone;
    readonly candidates: readonly string[];
    readonly min: number;
    readonly max: number;
    /**
     * The words to choose between, when that is the question. Present exactly when `from` is not,
     * and the table draws buttons instead of lighting up cards.
     */
    readonly options?: readonly string[];
    /**
     * The numbers to choose between, when that is the question: "pay X life". Present exactly when
     * `from`, `options` and `targetChoices` are all absent, and the table draws a row of numbers.
     */
    readonly numbers?: { readonly min: number; readonly max: number };
    /**
     * Where something else on the stack may be pointed instead: "you may choose new targets for
     * the copy". The table draws one button per target and a way to decline, because declining is
     * an answer. See `TargetDecisionSpec`.
     */
    readonly targetChoices?: readonly Target[];
  } | null;
  /**
   * A ward this seat is being asked to pay (CR 702.21b), and what it loses by declining.
   *
   * Offered to the seat *paying*, which is never the controller of the ability that asked — so
   * unlike `mustChoose` and `mustDecide`, the seat this appears for is the one whose spell is at
   * risk rather than the one resolving something. `canPay` is always true when this is non-null:
   * `settlePayment` has already resolved the case where the cost cannot be met, so the table never
   * has to draw a button it would have to grey out.
   */
  readonly mustPay: {
    readonly prompt: string;
    readonly cost: string;
    /** The warded permanent, so the table can point at what is doing this. */
    readonly ward: string;
    /** The spell or ability that is countered by declining, in the words the stack uses. */
    readonly spell: string;
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
  /**
   * Deals this seat may offer, and deals waiting on its answer. See `GameState.pacts`.
   *
   * Present in every branch of this function, which no other field is: a pact is not gated on
   * priority or on a step, because two players agreeing to leave each other alone is not a thing
   * the turn structure has an opinion about. The one gate is the engine's own — one live offer per
   * direction — and it shows up here as an opponent missing from `offer`.
   */
  readonly pacts: {
    /** Per opponent, the deals that could be put to them right now. */
    readonly offer: readonly { readonly seat: SeatIndex; readonly kinds: readonly PactKind[] }[];
    /** Offers waiting on this seat, by pact id, oldest first. */
    readonly answer: readonly string[];
  };
  /** Mana floating right now. */
  readonly pool: ManaPool;
  /** Mana that could still be produced from untapped permanents. */
  readonly potential: ManaPool;
}

/**
 * The deals a seat may offer now, and the ones it owes an answer to.
 *
 * Nothing is offered once the game is finished, which is the only state that closes this down: the
 * reducer refuses every action on a finished table, so a UI still showing a deal button would be
 * offering a move the engine would refuse.
 */
function pactOptions(state: GameState, seat: SeatIndex): LegalActions['pacts'] {
  if (state.finished || state.seats[seat]?.eliminated === true) return { offer: [], answer: [] };
  const offer: { seat: SeatIndex; kinds: readonly PactKind[] }[] = [];
  for (const other of state.seats) {
    if (other.index === seat || other.eliminated) continue;
    const pending = state.pacts.some(
      (p) => p.status === 'offered' && p.from === seat && p.to === other.index,
    );
    if (!pending) offer.push({ seat: other.index, kinds: PACT_KINDS });
  }
  return {
    offer,
    answer: state.pacts.filter((p) => p.status === 'offered' && p.to === seat).map((p) => p.id),
  };
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
/**
 * Convoke (CR 702.51): which creatures to tap for a cost, and what is left of it to pay.
 *
 * **It reduces the cost rather than making mana**, which is the one design decision here worth
 * stating. Modelling a convoked creature as a mana source would have been a few lines — it is
 * almost exactly a dual land, "one generic or one of my colour" — but a mana source that
 * over-produces leaves mana floating, and convoke cannot do that. There is no way to clean it up
 * afterwards either, because a Dark Ritual means floating mana is sometimes legitimate and nothing
 * downstream could tell the two apart.
 *
 * **It taps nothing it does not have to.** Mana first: a spell the lands already cover convokes
 * nobody, because a tapped creature cannot block and the player would rather keep it. Only the
 * shortfall is convoked, one pip at a time, coloured pips first while a creature of that colour is
 * available — a greedy assignment rather than an optimal one, which for convoke is the same thing
 * often enough and never offers a cast that cannot be paid.
 *
 * **Summoning sickness does not stop it.** Tapping for convoke is neither attacking nor activating
 * an ability, so a creature that arrived this turn may be tapped for it (CR 702.51a) — the one rule
 * about convoke that is easy to get wrong in the direction of being too strict.
 *
 * Returns null when even convoke cannot cover the cost. `legalActions` and `castSpell` both call
 * this, so there is one answer to "can this be paid for" rather than an offer and a refusal.
 */
/**
 * Which creatures to tap to crew a Vehicle, or `null` when the board cannot reach the number.
 *
 * Convoke's sibling, and built the same way for the same reason: one planner, called by
 * `activatablePlays` to decide whether to offer the crew and by `activate` as it pays, so the offer
 * and the payment can never disagree about whether the Vehicle can be driven. That is the bug class
 * this file exists to prevent, and it is the second mechanic in a row to come close to growing a
 * second answer.
 *
 * **Smallest creatures first**, which is the opposite of what reads naturally and is what a player
 * does. "Any number with total power N or greater" could always be satisfied by tapping the biggest
 * creature on the board, and that is the worst choice available: a tapped creature cannot attack or
 * block, so the creature you want left standing is the big one. Tapping three 1/1s to crew a
 * Vehicle costs three bodies that were not attacking for much anyway; tapping the 5/5 costs the
 * attack. The cost of the greedy rule is that it sometimes taps one creature more than it had to.
 *
 * A creature with no power is skipped rather than tapped: it can legally be tapped to crew and it
 * contributes nothing, so tapping it is a blocker thrown away for no progress.
 *
 * Summoning sickness is deliberately not asked about. Tapping a creature to pay a cost is not the
 * same as that creature activating a {T} ability, so a creature that arrived this turn may crew —
 * which is most of what makes a Vehicle castable and crewable on the same turn.
 */
export function crewPlan(
  state: GameState, seat: SeatIndex, need: number, vehicle: string,
): readonly string[] | null {
  if (need <= 0) return [];
  const available: { id: string; power: number }[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    if (id === vehicle) continue;
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const ch = characteristicsOf(state, inst);
    if (!ch.isCreature || ch.power <= 0) continue;
    available.push({ id, power: ch.power });
  }
  available.sort((a, b) => a.power - b.power);
  const tapped: string[] = [];
  let total = 0;
  for (const entry of available) {
    if (total >= need) break;
    tapped.push(entry.id);
    total += entry.power;
  }
  return total >= need ? tapped : null;
}

export function convokePlan(
  state: GameState, seat: SeatIndex, cost: ManaCost, sources: readonly ManaSourceEntry[],
): { readonly tapped: readonly string[]; readonly cost: ManaCost } | null {
  const pool = poolOf(state, seat);
  if (canAfford(pool, cost, sources)) return { tapped: [], cost };

  /** Untapped creatures, with the colours each could pay for. */
  const available: { id: string; colors: readonly ManaType[] }[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const ch = characteristicsOf(state, inst);
    if (!ch.isCreature) continue;
    available.push({ id, colors: ch.colors as readonly ManaType[] });
  }

  const tapped: string[] = [];
  let left: ManaCost = cost;
  let leftSources = [...sources];
  for (let guard = 0; guard < 24 && available.length > 0; guard += 1) {
    // A coloured pip first, and only one a creature on the board can actually pay: spending a
    // green creature on a generic pip while {G} goes unpaid is how a greedy assignment fails.
    let pick = -1;
    let paying: ManaType | 'generic' = 'generic';
    for (let i = 0; i < available.length && pick < 0; i += 1) {
      for (const color of available[i]!.colors) {
        if ((left.colors[color] ?? 0) > 0) { pick = i; paying = color; break; }
      }
    }
    if (pick < 0 && left.generic > 0) { pick = 0; paying = 'generic'; }
    if (pick < 0) break;
    const chosen = available.splice(pick, 1)[0]!;
    tapped.push(chosen.id);
    left = paying === 'generic'
      ? { ...left, generic: left.generic - 1 }
      : { ...left, colors: { ...left.colors, [paying]: (left.colors[paying] ?? 0) - 1 } };
    // A creature tapped for convoke cannot also be tapped for mana, so it leaves the source list.
    leftSources = leftSources.filter((source) => source.key !== chosen.id);
    if (canAfford(pool, left, leftSources)) return { tapped, cost: left };
  }
  return null;
}

export function manaSources(state: GameState, seat: SeatIndex): ManaSourceEntry[] {
  const free: ManaSourceEntry[] = [];
  const painful: ManaSourceEntry[] = [];
  const life = state.seats[seat]?.life ?? 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    // A face-down permanent is a 2/2 creature with no abilities, so it taps for nothing — a
    // face-down Forest is not a Forest (CR 707.2).
    if (isFaceDownPermanent(inst)) continue;
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
  /** One land a turn, plus any extra drops something has handed this seat (CR 505.5b). */
  const landsAllowed = 1 + (state.extraLands[String(seat)] ?? 0);
  const tax = state.seats[seat]?.commanderTax ?? 0;

  // A commander is cast from the command zone, which is why it is a second list rather than part
  // of the hand. Without this the engine never offered a commander at all — in a format whose
  // whole point is the commander.
  /*
    Four zones a spell can be cast from, which is four lists rather than one.

    The hand is the ordinary case; the command zone is a commander (CR 903.8); the graveyard is
    flashback (CR 702.33); and exile is a foretold card (CR 702.143b). Each of the three unusual
    ones is filtered to the cards that actually offer it — a card in a graveyard with no flashback
    is not a play and never appears here, which is also why none of them go through `why`: there is
    no sense in telling a player that each of the nine cards in their graveyard cannot be cast.

    The exile list is the narrowest of the four. A foretold card is face down in exile, and so is a
    creature a Banisher Priest took — `foretoldTurn` is what tells them apart, and it belongs to
    whoever foretold it rather than to whoever owns the card.
  */
  const castable = [
    ...listAt(state, zoneKey(seat, 'hand')).map((id) => ({ id, fromCommand: false, flashback: false, foretold: false })),
    ...listAt(state, zoneKey(seat, 'command')).map((id) => ({ id, fromCommand: true, flashback: false, foretold: false })),
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => scriptFor(state.cardDefs[state.instances[id]?.defKey ?? '']?.name)?.flashback !== undefined)
      .map((id) => ({ id, fromCommand: false, flashback: true, foretold: false })),
    ...listAt(state, zoneKey(seat, 'exile'))
      .filter((id) => {
        const inst = state.instances[id];
        if (inst?.foretoldTurn === undefined || inst.foretoldTurn === state.turn) return false;
        return scriptFor(state.cardDefs[inst.defKey]?.name)?.foretell !== undefined;
      })
      .map((id) => ({ id, fromCommand: false, flashback: false, foretold: true })),
  ];

  for (const { id, fromCommand, flashback, foretold } of castable) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const def = state.cardDefs[inst.defKey];
    const ch = characteristicsOf(state, inst);
    const script = scriptFor(def?.name);

    /*
      Morph: the same card offered a second time, as a {3} face-down 2/2 (CR 702.37a).

      Offered **here**, before the printed cost is looked at, which is the whole point: a morph you
      cannot afford is still castable face down, and a block placed after the affordability check
      below would have hidden the one play the card is in the deck for. A seven-mana creature on
      turn three is a 2/2 for {3} — that is what morph is, and a table that only offered it when
      the real cost was payable would have offered it exactly when nobody wants it.

      From hand only, and never with the flashback or commander-zone pass: morph is about the card
      in your hand, and nothing in this pool has both.
    */
    if (script?.morph !== undefined && !flashback && !fromCommand && sorcerySpeed) {
      const faceDownCost = parseManaCost(MORPH_COST);
      if (canAfford(poolOf(state, seat), faceDownCost, sources)) {
        out.push({
          kind: 'cast', card: id, name: ch.name, faceDown: true,
          // Named for the player's own benefit: only they can see which card it is, and a menu of
          // three identical "Cast face down" rows would be unusable.
          description: `Cast ${ch.name} face down (${MORPH_COST}, a 2/2)`,
          manaCost: MORPH_COST, targetSpecs: [], candidates: [],
          isManaAbility: false, sacrificeOptions: [],
        });
      }
    }

    if (ch.isLand) {
      // A land commander would be *played*, not cast, and nothing in the pool is one; refusing to
      // offer it is better than offering a land drop out of the command zone.
      if (fromCommand) continue;
      if (sorcerySpeed && landsPlayed < landsAllowed) {
        out.push({
          kind: 'land', card: id, name: ch.name, description: `Play ${ch.name}`,
          manaCost: '', targetSpecs: [], candidates: [], isManaAbility: false, sacrificeOptions: [],
        });
      } else if (!sorcerySpeed) {
        why(id, 'a land is played in your own main phase, with nothing on the stack');
      } else {
        why(id, landsPlayed > 1
          ? `you have already played ${landsPlayed} lands this turn`
          : 'you have already played a land this turn');
      }
      continue;
    }

    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant') || ch.keywords.has('flash');
    if (!instantSpeed && !sorcerySpeed) {
      why(id, 'sorcery speed: your own main phase, with nothing on the stack');
      continue;
    }

    /*
      Foretell: the special action that hides the card, offered beside its ordinary cast.

      A second play on the same card like the morph above, and offered on the same terms — the
      printed cost is not looked at, because {2} to exile it is a move you make *instead of*
      casting it and often because you cannot cast it. During your own turn only (CR 702.143a),
      which in this engine is the window a sorcery gets.
    */
    if (script?.foretell !== undefined && !flashback && !fromCommand && !foretold && sorcerySpeed) {
      const cost = parseManaCost(FORETELL_COST);
      if (canAfford(poolOf(state, seat), cost, sources)) {
        out.push({
          kind: 'foretell', card: id, name: ch.name,
          // Named for its own player, who is the only one who will ever see which card it was.
          description: `Foretell ${ch.name} (${FORETELL_COST}, face down in exile)`,
          manaCost: FORETELL_COST, targetSpecs: [], candidates: [],
          isManaAbility: false, sacrificeOptions: [],
        });
      }
    }

    // Flashback and foretell both replace the cost, so everything from here on — affordability, X,
    // the description — is about that cost rather than the printed one.
    const costShown = flashback ? script?.flashback?.cost ?? ''
      : foretold ? script?.foretell?.cost ?? ''
        : def?.manaCost ?? '';
    const printed = parseManaCost(costShown);
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
    /*
      Convoke widens what may pay for this one spell, so affordability is asked of the plan rather
      than of the lands alone — and the plan is what `castSpell` recomputes, so the offer and the
      payment cannot disagree.
    */
    const convoked = script?.convoke === true ? convokePlan(state, seat, cost, sources) : null;
    if (script?.convoke === true && convoked === null) {
      why(id, 'not enough mana, counting every land you could tap and every creature you could convoke');
      continue;
    }
    if (convoked === null && !canAfford(poolOf(state, seat), cost, sources)) {
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
          manaCost: costShown, ...taxOn, ...xOn, modes, targetSpecs: specs, candidates,
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

    /*
      And convoke said out loud on the play, because otherwise the table offers a seven-mana spell
      off four lands and gives no reason at all.

      The count rather than the names: which creatures get tapped is the engine's to decide (see
      `convokePlan`), and a player reading "convoking 3" knows what the cast is about to cost them
      without having to work out which three.
    */
    const convokeNote = convoked !== null && convoked.tapped.length > 0
      ? ` (convoking ${convoked.tapped.length})`
      : '';
    out.push({
      kind: 'cast', card: id, name: ch.name,
      description: flashback
        ? `Cast ${ch.name} from your graveyard (flashback ${costShown})`
        : foretold
          ? `Cast ${ch.name} from exile (foretold ${costShown})`
          : fromCommand && tax > 0
            ? `Cast ${ch.name} (+{${tax}} tax)`
            : `Cast ${ch.name}${convokeNote}`,
      manaCost: costShown, ...taxOn, ...xOn, targetSpecs: specs, candidates,
      ...(flashback ? { flashback: true } : {}),
      ...(foretold ? { foretold: true } : {}),
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
    // A flashback casting pays the flashback cost and nothing else, so the kicker is not on offer
    // with it: the two are alternative costs, and no card in the pool has both.
    const kicker = flashback || foretold ? undefined : script?.kicker;
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
    // Face down is face down: no name, no types, no abilities to activate (CR 707.2).
    if (isFaceDownPermanent(inst)) continue;
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
      // A counter is a cost like the life and the loyalty above: with none left to remove, the
      // ability is not offered at all rather than offered and then refused.
      if (ability.cost.removeCounter !== undefined) {
        const held = inst.counters[ability.cost.removeCounter.counter] ?? 0;
        if (held < ability.cost.removeCounter.amount) continue;
      }
      if (ability.cost.mana
        && !canAfford(poolOf(state, seat), parseManaCost(ability.cost.mana), sources)) continue;
      // Life is a cost like any other: an ability you cannot pay for is not offered, which is why
      // a Mana Confluence stops making mana at one life and a City of Brass does not.
      if (ability.cost.life !== undefined && (state.seats[seat]?.life ?? 0) <= ability.cost.life) continue;
      // An ability whose cost is a sacrifice is not activatable with nothing to sacrifice.
      const victims = sacrificeOptions(state, seat, id, ability.cost);
      if (ability.cost.sacrifice !== undefined && victims.length === 0) continue;

      /*
        Crew, asked of the same planner that will pay it (CR 702.122a).

        A Vehicle on a board with nobody to drive it is not offered at all, which is the same rule
        as the sacrifice above and for the same reason: the alternative is a table offering a crew
        the engine then refuses.
      */
      const crew = ability.cost.crew === undefined
        ? null
        : crewPlan(state, seat, ability.cost.crew, id);
      if (ability.cost.crew !== undefined && crew === null) continue;

      const specs = ability.targets ?? [];
      const { ok, candidates } = playableTargets(state, specs, seat, id);
      if (!ok) continue;

      out.push({
        kind: 'activate', card: id, name: ch.name,
        // The count said out loud, exactly as convoke says it: a player about to tap three of their
        // own creatures should be told it is three before they press the button, and which three is
        // the engine's business.
        description: crew === null || crew.length === 0
          ? ability.description
          : `${ability.description} (tapping ${crew.length})`,
        manaCost: ability.cost.mana ?? '', abilityIndex: i,
        ...(inHand ? { fromHand: true } : {}),
        targetSpecs: specs, candidates, isManaAbility: ability.produces !== undefined,
        sacrificeOptions: victims,
      });
    }
  }

  /*
    Turning a morph face up (CR 702.37b), which is why this is a loop of its own.

    Not an ability — the loop above would have skipped it anyway, because a face-down permanent has
    none — but a **special action**: no stack, no priority in between, nothing an opponent may do
    about it. Any time its controller holds priority, which includes the middle of combat after
    blockers are declared, and that is what players hold a morph for.

    The card is read by name here, from under the face-down permanent, which is the one place in
    the engine that deliberately looks at what a face-down thing is. That is safe because this list
    is built per seat: `legalActions(state, seat)` is only ever asked about the seat being told its
    own options, so the morph cost shown is the controller reading their own card.
  */
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || !inst.faceDown) continue;
    const def = state.cardDefs[inst.defKey];
    const morph = scriptFor(def?.name)?.morph;
    if (morph === undefined) continue;
    const mana = morph.cost.mana ?? '';
    const cost = parseManaCost(mana);
    if (cost.unsupported !== undefined) continue;
    if (!canAfford(poolOf(state, seat), cost, sources)) continue;
    /*
      And the life half, refused at exactly the life that would kill you (CR 118.4).

      The same rule `activate` applies to a Mana Confluence, and the reason the cost is an
      `AbilityCost` rather than a second kind of cost: a Zombie Cutthroat on three life is not
      offered a turn-up, because paying for it would lose the game and a cost you cannot pay is not
      a cost you may choose to pay.
    */
    if (morph.cost.life !== undefined && (state.seats[seat]?.life ?? 0) <= morph.cost.life) continue;
    const word = morph.mega === true ? 'megamorph' : 'morph';
    out.push({
      kind: 'turnUp', card: id, name: def?.name ?? 'that card',
      description: `Turn ${def?.name ?? 'it'} face up (${word} ${morphCostText(morph.cost)})`,
      manaCost: mana, targetSpecs: [], candidates: [],
      isManaAbility: false, sacrificeOptions: [],
    });
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
    && state.pendingPayment === null
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
        prompt: decision.prompt,
        ...(decision.from === undefined ? {} : { from: decision.from }),
        ...(decision.options === undefined ? {} : { options: [...decision.options] }),
        ...(decision.numbers === undefined ? {} : { numbers: { ...decision.numbers } }),
        ...(decision.targetChoices === undefined
          ? {}
          : { targetChoices: [...decision.targetChoices] }),
        candidates: decision.candidates, min: decision.min, max: decision.max,
      }
    : null;

  const payment = state.pendingPayment;
  const mustPay: LegalActions['mustPay'] = payment !== null && payment.seat === seat
    ? {
        prompt: payment.prompt,
        cost: payment.cost,
        ward: payment.source,
        spell: state.stackObjects[payment.counters]?.description ?? 'it',
      }
    : null;

  const empty: LegalActions = {
    seat, step: state.step, hasPriority, isActivePlayer: state.activeSeat === seat,
    canPass: false, passLabel: '', plays: [], attackers: [], mustAttack: [], attackAims: [],
    blockers: [], mustOrder: [],
    mustDiscard, mustDeclare, mustSettleHand, bottomOwed: bottomOwed(state, seat), mustChoose,
    mustDecide, mustPay, blocked: [], pacts: pactOptions(state, seat), pool: poolOf(state, seat),
    potential,
  };
  if (!state.automated || state.finished) return empty;
  // Opening hands come before anything else, including priority.
  if (state.openingHands) return mustSettleHand ? { ...empty, passLabel: 'Keep' } : empty;
  // So does a trigger waiting for its targets: nothing else can happen until it has them.
  if (choice !== null) return mustChoose === null ? empty : { ...empty, passLabel: 'Choose a target' };
  // And so does a spell that stopped mid-resolution to ask somebody a question. It is still on the
  // stack; nobody holds priority until it is answered, including the player who cast it.
  if (decision !== null) return mustDecide === null ? empty : { ...empty, passLabel: 'Choose' };
  // And so does a ward: the spell is on the stack, nobody holds priority, and the only move at the
  // table is the one answer this seat owes.
  if (payment !== null) return mustPay === null ? empty : { ...empty, passLabel: `Pay ${payment.cost}` };
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
