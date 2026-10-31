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
import { defKeyFor, isFaceDownPermanent, zoneKey, type CardDef } from './cards.js';
import { listAt } from './cardActions.js';
import { allAbilitiesLost, characteristicsOf, hasType } from './characteristics.js';
import {
  atSorcerySpeed, bottomOwed, modeCombinations, modeTargetSpecs, modesOf, pendingDeclaration,
  sacrificeOptions, stackTop, unblockedAttackersOf,
} from './automation.js';
import {
  canBlock, damageOrdersOwed, forcedAttackers, legalAttackers, legalBlockers, legalDefenders,
} from './combat.js';
import { energyOf, poolOf } from './effects.js';
import {
  addMana, canAfford, maxAffordableX, parseManaCost,
  type ManaCost, type ManaPool, type ManaType,
} from './mana.js';
import { abilityTargetSpecs, scriptFor } from './scripts.js';
import {
  FORETELL_COST, MORPH_COST, morphCostText,
  type AbilityDef, type CardScript, type TargetSpec,
} from './scriptTypes.js';
import { BESTOW_TARGET, legalTargets } from './targeting.js';
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
  readonly kind: 'land' | 'cast' | 'activate' | 'turnUp' | 'foretell' | 'suspend';
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
   * What the permanents on the table did to this cast's generic mana, and absent when they did
   * nothing — negative for a reduction, positive for a tax.
   *
   * Separate from `manaCost` for the reason `commanderTax` is: the cost printed on the card has
   * not changed, and a table that rewrote it would be lying about which card this is. The client
   * shows the printed cost and this beside it, with `costNote` saying which permanent is doing it.
   */
  readonly costChange?: number;
  /** "Instant and sorcery spells you cast cost {1} less", in the card's own words. */
  readonly costNote?: string;
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
  /**
   * And the same for an ability used from the **graveyard**: unearth, which is not a cast (D183).
   * The table draws it on the card in the graveyard row, beside the flashback and escape plays
   * that live there.
   */
  readonly fromGraveyard?: boolean;
  /** Set on the second of the two plays a kicker offers: this one pays it (CR 702.32a). */
  readonly kicked?: boolean;
  /**
   * Set on the second of the two plays a buyback offers: this one pays it (CR 702.26a).
   *
   * The kicker's arrangement again, and the table needs no new way to draw it — it is a second row
   * on the same card at a higher price, and the row's own words say what the price buys.
   */
  readonly buyback?: boolean;
  /**
   * How many times this play pays the card's replicate cost, and so how many copies it makes.
   *
   * One play per count, which is the kicker's arrangement rather than {X}'s picker: the ceiling is
   * the mana available and in this pool that is a short list. Absent on the printed cast, which is
   * the same play with no copies. See `CardScript.replicate`.
   */
  readonly replicate?: number;
  /**
   * Set on a play that casts the card out of its owner's graveyard for its flashback cost
   * (CR 702.33).
   *
   * A separate play rather than a flag on the hand's one, for the same reason the kicker is: the
   * table draws it in a different row — the graveyard — and the cost shown is not the printed one.
   */
  readonly flashback?: boolean;
  /**
   * Set on a play that casts the card out of its owner's graveyard for its escape cost
   * (CR 702.139).
   *
   * A separate play for the same reason flashback's is — the table draws it in the graveyard row
   * and the cost shown is not the printed one — and a separate *flag* from flashback because the
   * two differ at the end rather than at the start: a flashback spell is exiled as it leaves the
   * stack and an escaped one is not.
   */
  readonly escape?: boolean;
  /**
   * How many cards this play would exile from your graveyard to pay for itself: escape's fixed
   * count, or the number delve worked out (CR 702.112, CR 702.139).
   *
   * Reported because it is the half of the cost the printed mana cost does not show, and a table
   * that showed "{B}" for a Gurmag Angler without saying "and six cards out of your graveyard"
   * would be hiding the expensive half. Which cards they are is deliberately not here: that is
   * the engine's choice, recomputed as the spell is cast, so naming them in the offer would be
   * promising something the payment is not bound to.
   */
  readonly exiles?: number;
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
   * Set on a play that casts the card **without paying its mana cost**, because something offered
   * it (CR 702.85a).
   *
   * Not a cheaper cost but no cost, which is why it is a flag rather than a `manaCost` of `{0}`:
   * the table draws no mana symbols at all for it, and the engine refuses the cast unless
   * `pendingOfferedCast` still names this card. The play carries everything else a cast carries —
   * targets, modes, a creature to sacrifice — because an offered cast chooses all of them.
   */
  readonly offered?: boolean;
  /**
   * Set on the play that casts the card for its evoke cost, which buys the spell and gives up the
   * permanent (CR 702.74a).
   *
   * A second play on the same card like the kicker's, and the opposite kind of choice: the kicker
   * pays more for more, and this pays less for less. The table needs no new row for it — a card
   * that is already offered once is offered twice, with a different cost and a description that
   * says what the cheap one costs you.
   */
  readonly evoked?: boolean;
  /**
   * Set on the play that casts the card for its dash cost: hasty now, back in hand at the end of
   * the turn (CR 702.109a).
   *
   * Evoke's flag and its mirror, and a separate one for the same reason flashback and escape are
   * separate: what the two costs *do* differs after the spell has resolved, and a table that
   * offered one flag for both would be offering a card that sacrifices itself as a card that
   * attacks.
   */
  readonly dashed?: boolean;
  /**
   * Set on the play that casts the card as an **Aura** for its bestow cost (CR 702.103b).
   *
   * The third flag in this family and the only one that changes what the play *asks for*: this one
   * carries a target where the card's ordinary cast carries none, so the table walks the player
   * through choosing a creature before the cast is sent.
   */
  readonly bestowed?: boolean;
  /**
   * Set on the play that casts the card for its spectacle cost, which the board had to earn
   * (CR 702.137a).
   *
   * The fourth of the family, and the first that is not always there: the row appears only once an
   * opponent has lost life this turn, which is why its description says so — a cheap cast that
   * comes and goes with the board needs to tell the player why it is on offer.
   */
  readonly spectacled?: boolean;
  /**
   * Set on the play that casts the card for its overload cost (CR 702.96).
   *
   * The fifth of the family and the only one that is *dearer* than the printed cast, so it is the
   * one row here that can be absent for the ordinary reason — the mana is not there. It carries no
   * candidates, because an overloaded spell targets nothing.
   */
  readonly overloaded?: boolean;
  /**
   * Which face of a two-faced card this play casts, as an index into `CardDef.faces.cards`
   * (CR 708).
   *
   * One play per face, like the kicker's and the morph's: a split card is offered twice and never
   * as itself, and an adventurer is offered as its creature *and* as its adventure. Nothing in the
   * table had to change for it — a menu that already shows one card several times shows this.
   */
  readonly half?: number;
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
   * Permanents that could be sacrificed to pay for this, when its cost asks for one. Empty for
   * everything else — a cost is paid as the ability is activated, so the choice travels with the
   * play rather than being asked for afterwards.
   *
   * Creatures for every cost but one, and `sacrificeKind` below says which: the Arcbound Ravager's
   * list is artifacts, and most of them are not creatures at all.
   */
  readonly sacrificeOptions: readonly string[];
  /**
   * Set when the cost eats an **artifact** rather than a creature, and absent otherwise — the
   * Ravager's outlet, and nothing else in this pool.
   *
   * The list alone cannot be read for this, which is why it is a field rather than something each
   * reader works out. An artifact cost on a board whose only artifact is a Juggernaut offers one
   * artifact creature, and that is indistinguishable from a creature cost: a reader guessing from
   * the candidates would guess wrong exactly where the board is narrowest.
   *
   * Two readers would otherwise each invent it. The bar has to ask the question in the right words,
   * and "tap a creature to sacrifice" over an artifact cost names the wrong half of the board. And
   * the bot's judgement about what it minds losing is a different judgement for a Bonesplitter than
   * for a Centaur Courser — see `spentArtifact` for how different.
   */
  readonly sacrificeKind?: 'artifact';
  /**
   * Unblocked attackers that could be **returned to hand** to pay for this, when its cost asks for
   * one — ninjutsu, and nothing else so far (CR 702.49a).
   *
   * Its own list rather than a widening of `sacrificeOptions`, because the two costs do opposite
   * things to the permanent they take and a table that offered them under one name would be a
   * table asking "which creature do you want to lose" about a creature the player is keeping.
   * Absent for every other ability.
   */
  readonly returnOptions?: readonly string[];
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
    /**
     * Proliferate's question, whose candidates mix permanents with `seat:N` players
     * (CR 701.27a). The table lights each chosen player's own seat strip rather than trying to
     * light a card that does not exist.
     */
    readonly counters?: true;
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
   * A draw this seat may replace with a dredge (CR 702.52a), and what it would cost.
   *
   * The only question at this table that is about a card nobody has played: what is waiting is a
   * draw, and the answer decides whether it happens. `mill` is the price in cards off the top of
   * this seat's own library, and the library is known to be long enough — a dredge that cannot be
   * paid for is not offered at all, so there is no unaffordable answer to draw a button for.
   */
  readonly mustDredge: {
    readonly prompt: string;
    /** The card in the graveyard that would come back. */
    readonly card: string;
    readonly mill: number;
  } | null;
  /**
   * A card this seat may cast without paying for it, and what put it there (CR 702.85a).
   *
   * The plays for it are in `plays` like any other cast — the table needs no second way to draw a
   * cast — so what this field is for is the *sentence*: a row saying "Cast Lightning Bolt without
   * paying its mana cost" appearing out of nowhere, on a card that was in a library a moment ago,
   * is unreadable without "Bloodbraid Elf cascades into it" above it. `bottom` is how many cards
   * go back under the library either way, which is the cost of the keyword and the other thing a
   * player wants to see.
   */
  readonly mustCastOffered: {
    readonly prompt: string;
    /** The card on offer, so the table can show it rather than only name it. */
    readonly card: string;
    /** The spell or permanent whose keyword offered it. */
    readonly source: string;
    /**
     * What taking it costs, in the printed `{R}` form, and the empty string for nothing at all.
     *
     * Cascade's offer is free and madness's is not, and the difference is the whole of what the
     * player is deciding — a {R} they may not have untapped. The play itself carries the cost too;
     * this is the one on the sentence above it.
     */
    readonly cost: string;
    /** How many other cards were exiled with it, bound for the bottom of the library. */
    readonly bottom: number;
    /**
     * Whether the cast **must** be taken, which is suspend's and nothing else's (CR 702.62c).
     *
     * The table needs it as much as the engine does: three of the four offers draw a Decline beside
     * the cast and this one must not, because pressing it would be a move the engine refuses. A
     * button that cannot be pressed is worse than no button — which is what the first run of
     * `LIST=suspend` showed, with "Cast it Decline" on a question that has one answer.
     */
    readonly mandatory?: boolean;
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
  /** Using it sacrifices it: a Treasure, which makes one mana once. See `ManaSource.sacrifices`. */
  readonly sacrifices?: boolean;
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

/**
 * The cards a cost paid out of the graveyard would take, in the order it would take them.
 *
 * Escape and delve both say "exile cards from your graveyard" and neither says which, so the
 * choice is the engine's — the same arrangement convoke has for which creatures get tapped, and
 * for the same reason: a client naming them would be a client deciding which of its own resources
 * to spend, and the offer and the payment have to agree about a cost either way.
 *
 * **The order is the whole of the judgement, and it is one rule: a card nothing can use goes
 * first.** A graveyard in this pool is not a pile — a Think Twice can be cast out of it, a
 * Phoenix of Ash can escape out of it, a Gravedigger can take a creature back from it — so
 * exiling the wrong three cards to escape is paying twice for one spell. Cards with no second
 * life of their own (no flashback, no escape) go before the ones that have one, and within each
 * group the graveyard's own order decides, oldest first. It is a heuristic and it is the cheap
 * one: a Gravedigger in hand makes a dead creature worth keeping and nothing here knows that.
 *
 * `exclude` is the card doing the escaping, which is what makes "three **other** cards" mean what
 * it says. `want` is a cap rather than a promise — a shorter list than asked for is the answer
 * "this cost cannot be paid", and `castablePlays` reads it that way.
 */
export function graveyardFodder(
  state: GameState, seat: SeatIndex, exclude: string | undefined, want: number,
): readonly string[] {
  if (want <= 0) return [];
  const spare: string[] = [];
  const useful: string[] = [];
  for (const id of listAt(state, zoneKey(seat, 'graveyard'))) {
    if (id === exclude) continue;
    const script = scriptFor(state.cardDefs[state.instances[id]?.defKey ?? '']?.name);
    if (script?.flashback !== undefined || script?.escape !== undefined) useful.push(id);
    else spare.push(id);
  }
  return [...spare, ...useful].slice(0, want);
}

/**
 * How few cards delve has to exile to make this spell castable, and the cost that leaves
 * (CR 702.112).
 *
 * **The smallest number, not the largest**, which is the one real decision in the mechanic. Delve
 * is offered in mana and expensive in everything else: the graveyard is what the escape card and the
 * flashback card spend, so a plan that always exiled the maximum would be paying for a Gurmag
 * Angler with cards the deck had other uses for. So this walks up from nothing and stops at the
 * first count that can be paid for — a spell castable without delving at all delves nothing, and
 * one short by two mana delves twice.
 *
 * Only generic, because that is the rule (CR 702.112a): a card exiled this way pays for {1} and
 * can never pay a coloured pip, so the loop stops at `cost.generic` however many cards are there.
 *
 * `null` means it cannot be cast even with every card in the graveyard behind it, which is a
 * refusal to offer rather than an offer to refuse — the same shape `convokePlan` returns and for
 * the same reason.
 */
export function delvePlan(
  state: GameState, seat: SeatIndex, cost: ManaCost, sources: readonly ManaSourceEntry[],
): { readonly exiled: readonly string[]; readonly cost: ManaCost } | null {
  const pool = poolOf(state, seat);
  const available = graveyardFodder(state, seat, undefined, cost.generic);
  for (let n = 0; n <= available.length; n += 1) {
    const left = withCostChange(cost, -n);
    if (canAfford(pool, left, sources)) return { exiled: available.slice(0, n), cost: left };
  }
  return null;
}

export function manaSources(state: GameState, seat: SeatIndex): ManaSourceEntry[] {
  const free: ManaSourceEntry[] = [];
  /*
    Sources that are **spent** rather than tapped, queued between the free ones and the painful
    ones (see `ManaSource.sacrifices` for why order is all this needs to be).

    Ahead of a life cost rather than behind it, which is the one judgement in here. A Treasure
    exists to be spent and a life total cannot be rebuilt, so cracking the Treasure before paying
    a Mana Confluence is the play a person makes at any life total worth protecting — and the
    painful sources already drop out of this list entirely once the life is nearly gone, so the
    low-life case was never the one at risk.
  */
  const spent: ManaSourceEntry[] = [];
  const painful: ManaSourceEntry[] = [];
  const life = state.seats[seat]?.life ?? 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    // A face-down permanent is a 2/2 creature with no abilities, so it taps for nothing — a
    // face-down Forest is not a Forest (CR 707.2).
    if (isFaceDownPermanent(inst)) continue;
    // And a permanent whose abilities have been taken away taps for nothing: a Frogged Llanowar
    // Elves is a 1/1 with no text (CR 613.1f). See `allAbilitiesLost`.
    if (allAbilitiesLost(state, inst)) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities = script?.abilities ?? [];
    let usable: {
      index: number; produces: readonly ManaType[]; life: number; energy: number; sacrifices: boolean;
    }[] = [];
    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if (ability.produces === undefined || ability.produces.length === 0) continue;
      if (ability.cost.mana !== undefined) continue;
      /*
        `{T}` **or** a sacrifice of itself, where it used to be `{T}` and never a sacrifice.

        The old line refused any mana ability that sacrificed its own permanent, which made a
        Treasure token unplayable rather than merely unusual: the engine would create one, the
        auto-tapper would not see its mana, `canAfford` would say no, and the card the Treasure was
        made for would sit in hand with the Treasure sitting beside it. Nothing would have errored.

        A sacrifice is a cost this seat can always decide about from what it already has, which is
        the test this list applies to every other non-mana cost — the same reason a life cost
        counts and an energy cost counts once there is energy for it.
      */
      if (!ability.cost.tap && !ability.cost.sacrificeSelf) continue;
      if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      // A cost you cannot pay is not a cost you may pay (CR 118.4) — and paying down to nothing
      // is a legal way to lose the game, so the engine stops one short of it.
      const cost = ability.cost.life ?? 0;
      if (cost > 0 && life <= cost) continue;
      /*
        And energy, which this list had been silently ignoring — found by `measure/energy.mjs`
        rather than by reading, because the symptom was an absence: over 288 games the Aether Hub
        gave out thirty-six energy and **none of it was ever spent**.

        The reason is right here. A Hub's coloured rows cost `{T}` and one energy, and until this
        line the filter only looked at mana, tap, sacrifice and life — so the auto-tapper saw five
        free rows and would happily tap the Hub for a colour it had not paid for, with no energy at
        all. A land that quietly makes any colour for nothing is not the card.
      */
      const energyCost = ability.cost.energy ?? 0;
      if (energyCost > 0 && energyOf(state, seat) < energyCost) continue;
      usable.push({
        index: i,
        produces: ability.produces as readonly ManaType[],
        life: cost,
        energy: energyCost,
        sacrifices: ability.cost.sacrificeSelf === true,
      });
    }
    /*
      A permanent with both an offered tap and a paid one keeps only the offered ones, since
      charging for a tap that did not need it is the one mistake that cannot be taken back.

      The Aether Hub is the first card in the pool actually shaped this way — `{T}: Add {C}` beside
      `{T}, Pay {E}: Add a colour` — and this is the line that decides what the **auto-tapper** does
      with it: it takes the colourless row and leaves the energy alone. That is deliberately
      conservative rather than clever. Spending a saved resource to fix a colour is a judgement
      about the next three turns, and the auto-tapper is a solver that only knows about this cost;
      the player keeps the choice, because `legalActions` still offers all six rows and the table
      draws them.
    */
    if (usable.some((u) => u.life === 0 && u.energy === 0)) {
      usable = usable.filter((u) => u.life === 0 && u.energy === 0);
    }
    /*
      And the same rule one step further: a permanent that can make mana *without* eating itself
      does that, and its sacrifice row is left for the player.

      Mind Stone is the card — `{T}: Add {C}` beside `{1}, {T}, Sacrifice: Draw a card` — and it is
      safe today only because the second row costs mana and is filtered out above. The next rock
      printed with a free sacrifice row would have had the auto-tapper eating it for one mana on
      turn three, which is the Mutavault mistake in `payFrom` wearing different clothes.
    */
    if (usable.some((u) => !u.sacrifices)) usable = usable.filter((u) => !u.sacrifices);
    if (usable.length === 0) continue;
    const cost = usable[0]!.life;
    const eats = usable[0]!.sacrifices;
    const bucket = eats ? spent : cost > 0 ? painful : free;
    // One source per permanent, because tapping it is what pays — and several tap abilities on
    // one permanent are a *choice* between them, not a sum. That is what a dual land is: two
    // abilities, one tap, one mana. Treating them as a sum would offer spells nobody can cast.
    if (usable.length === 1) {
      bucket.push({
        key: id, produces: usable[0]!.produces, abilityIndex: usable[0]!.index,
        ...(cost > 0 ? { life: cost } : {}),
        ...(eats ? { sacrifices: true } : {}),
      });
      continue;
    }
    bucket.push({
      key: id,
      produces: usable.flatMap((u) => u.produces),
      abilityIndex: usable[0]!.index,
      choose: true,
      ...(cost > 0 ? { life: cost } : {}),
      ...(eats ? { sacrifices: true } : {}),
    });
  }
  return [...free, ...spent, ...painful];
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
    // Nothing to reach for on a permanent with no abilities left. Kept in step with `manaSources`,
    // which is the point of both: one answer to "what can this seat pay".
    if (allAbilitiesLost(state, inst)) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    for (const ability of script?.abilities ?? []) {
      if (ability.produces === undefined) continue;
      if (ability.cost.tap) {
        // A creature's tap ability is unavailable while it is summoning sick.
        if (ch.isCreature && inst.enteredTurn >= state.turn && !ch.keywords.has('haste')) continue;
      }
      // Only offered mana abilities count towards what is reachable; one that costs mana would need
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

/**
 * Whether a spell with **split second** is on the stack (CR 702.19).
 *
 * The pool's first rule about the *stack* rather than about a card, a board or a step: while one of
 * these is waiting to resolve, nobody may cast a spell or activate anything that is not a mana
 * ability. Read here, in the one function that decides what a seat may do, so a table and a bot
 * both see the same empty list and neither needs to know why.
 *
 * Spells only, and that is the rule rather than a shortcut: the keyword is printed on instants and
 * sorceries and says "while this **spell** is on the stack", so an ability on the stack — even one
 * from a permanent whose card has the keyword — stops nothing.
 */
function splitSecondHeld(state: GameState): boolean {
  return state.stackOrder.some((stackId) => {
    const object = state.stackObjects[stackId];
    if (object === undefined || object.kind !== 'spell') return false;
    return scriptFor(state.cardDefs[object.cardKey]?.name)?.splitSecond === true;
  });
}

function castablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): Castable {
  const out: LegalPlay[] = [];
  const blocked: { card: string; reason: string }[] = [];
  /** Records the first reason a card gave, so a later one does not overwrite the real cause. */
  const why = (card: string, reason: string): void => {
    if (!blocked.some((entry) => entry.card === card)) blocked.push({ card, reason });
  };
  const sorcerySpeed = atSorcerySpeed(state, seat);
  /*
    Split second (CR 702.19): no casts at all while one is on the stack, whoever cast it.

    Checked once rather than per card, and the hand is told **why** rather than left silent — a hand
    that goes grey with no explanation is the complaint `blocked` exists to answer, and this is the
    only reason in that list which is about something sitting on the stack rather than about the card
    the player is looking at. Land drops need no mention: a land is played at sorcery speed, which
    means an empty stack, so a split-second spell has already ruled one out.
  */
  const splitSecond = splitSecondHeld(state);
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
  const zones = [
    ...listAt(state, zoneKey(seat, 'hand'))
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: false, fromAdventure: false, offered: false })),
    ...listAt(state, zoneKey(seat, 'command'))
      .map((id) => ({ id, fromCommand: true, flashback: false, escape: false, foretold: false, fromAdventure: false, offered: false })),
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => scriptFor(state.cardDefs[state.instances[id]?.defKey ?? '']?.name)?.flashback !== undefined)
      .map((id) => ({ id, fromCommand: false, flashback: true, escape: false, foretold: false, fromAdventure: false, offered: false })),
    /*
      And the second narrow list over the graveyard: a card with escape (CR 702.139).

      Its own list rather than a widening of the flashback one, the way the two exile lists below
      are two lists: the cost is different, the cards are different, and the two differ in what
      happens at the *end* — a flashback spell is exiled as it leaves the stack and an escaped one
      goes back to the graveyard it came from. One card could in principle have both and would be
      offered twice, which is what the rules say happens.
    */
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => scriptFor(state.cardDefs[state.instances[id]?.defKey ?? '']?.name)?.escape !== undefined)
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: true, foretold: false,
        fromAdventure: false, offered: false,
      })),
    ...listAt(state, zoneKey(seat, 'exile'))
      .filter((id) => {
        const inst = state.instances[id];
        if (inst?.foretoldTurn === undefined || inst.foretoldTurn === state.turn) return false;
        return scriptFor(state.cardDefs[inst.defKey]?.name)?.foretell !== undefined;
      })
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: true, fromAdventure: false, offered: false })),
    /*
      And the fifth: a creature in exile whose adventure resolved (CR 708).

      A second narrow list over the same zone rather than a widening of the one above it, because
      the two have nothing in common beyond the zone — a foretold card is face down, waiting a
      turn, and cast for a different cost, while this one is face up, castable at once, and cast
      for exactly what is printed on it. `onAdventure` is what makes it a play at all, which is
      also what keeps a Banisher Priest's prisoner out of this list.
    */
    ...listAt(state, zoneKey(seat, 'exile'))
      .filter((id) => state.instances[id]?.onAdventure === true)
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: false, fromAdventure: true, offered: false })),
    /*
      And the sixth: the one card somebody has been told they may cast for nothing (CR 702.85a).

      A list of at most one, read off `pendingOfferedCast` rather than off the zone, because what makes
      this card castable is not where it is — it is sitting in exile beside everything else that has
      ever been exiled — but the offer the engine is holding the table open for. Which is also why
      it is not filtered by anything: the offer was made to this seat about this card, and the only
      question left below is what the spell needs chosen before it goes on the stack.
    */
    ...(state.pendingOfferedCast !== null && state.pendingOfferedCast.seat === seat
      ? [{
          id: state.pendingOfferedCast.card, fromCommand: false, flashback: false, escape: false,
          foretold: false, fromAdventure: false, offered: true,
        }]
      : []),
  ];
  /*
    One entry per castable **face**, which is where a two-faced card stops needing special cases.

    A split card is offered as each of its halves and never as itself — it has no castable face of
    its own (CR 708.4) — and an adventurer is offered as its creature *and* as its adventure. From
    exile there is only ever the creature: the adventure has already been cast, and the flag that
    put the card there is the reason it is castable at all.
  */
  const castable = zones.flatMap((entry) => {
    const faces = state.cardDefs[state.instances[entry.id]?.defKey ?? '']?.faces;
    if (faces === undefined || entry.fromAdventure) return [{ ...entry, half: undefined as number | undefined }];
    const halves = faces.cards.map((_face, index) => ({ ...entry, half: index as number | undefined }));
    return faces.kind === 'split'
      ? halves
      : [{ ...entry, half: undefined as number | undefined }, ...halves];
  });

  for (const { id, fromCommand, flashback, escape, foretold, fromAdventure, offered, half } of castable) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    if (splitSecond) {
      // Only the hand is worth explaining: a card in a graveyard or in exile is not drawn with a
      // reason beside it, for the same reason none of those zones goes through `why` at all.
      if (!fromCommand && !flashback && !escape && !foretold && !fromAdventure && !offered) {
        why(id, 'a spell with split second is on the stack');
      }
      continue;
    }
    /*
      The face being offered, if this play is for one: `def`, `ch` and `script` are the half's from
      here down, so the cost checked, the timing, the targets, the description and the affordability
      message are all about the half rather than about the card it is printed on.
    */
    const faceDef = half === undefined ? undefined : state.cardDefs[inst.defKey]?.faces?.cards[half];
    const def = faceDef ?? state.cardDefs[inst.defKey];
    const ch = characteristicsOf(state, faceDef === undefined ? inst : { ...inst, castAs: defKeyFor(faceDef) });
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
    if (script?.morph !== undefined && !flashback && !escape && !fromCommand && !fromAdventure
      && sorcerySpeed) {
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
          kind: 'land', card: id, name: ch.name,
          // Named as the back of the card when that is what it is, because the player is looking at
          // a Hagra Mauling in their hand and "Play Hagra Broodpit" would otherwise read as a bug.
          description: half === undefined
            ? `Play ${ch.name}`
            : `Play ${ch.name} (the back of ${state.cardDefs[inst.defKey]?.name ?? 'this card'})`,
          manaCost: '', targetSpecs: [], candidates: [], isManaAbility: false, sacrificeOptions: [],
          ...(half === undefined ? {} : { half }),
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
    // An offered cast ignores the timing, because the ability offering it is what says when: cascade
    // casts its hit mid-resolution, with a spell on the stack underneath. See `castSpell`.
    if (!instantSpeed && !sorcerySpeed && !offered) {
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
    if (script?.foretell !== undefined && !flashback && !escape && !fromCommand && !foretold
      && !fromAdventure && sorcerySpeed) {
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

    /*
      And suspend, foretell's near-twin and the other play on a card in hand that is not a cast
      (CR 702.62a).

      The same window — your own main phase, nothing on the stack — and the same shape of row, with
      two differences the description carries: the cost is the **card's own** rather than a fixed
      {2}, and what it buys is public. "Three time counters" is the whole of what the other player
      needs to plan around, so the row says it.
    */
    if (script?.suspend !== undefined && !flashback && !escape && !fromCommand && !foretold
      && !fromAdventure && sorcerySpeed) {
      const cost = parseManaCost(script.suspend.cost);
      if (cost.unsupported === undefined && canAfford(poolOf(state, seat), cost, sources)) {
        const counters = Math.max(1, script.suspend.counters);
        out.push({
          kind: 'suspend', card: id, name: ch.name,
          description: `Suspend ${ch.name} (${script.suspend.cost}, ${counters} time counter`
            + `${counters === 1 ? '' : 's'} in exile)`,
          manaCost: script.suspend.cost, targetSpecs: [], candidates: [],
          isManaAbility: false, sacrificeOptions: [],
        });
      }
    }

    /*
      Evoke and dash: a second play on the same card, and the two alternative costs that change
      what the permanent does afterwards (CR 702.74a, CR 702.109a).

      **Above** the affordability check below, which is the whole reason it is here rather than
      beside the kicker it most resembles — and the same reason morph and foretell are up here. The
      turn this card is in the deck for is the turn its printed cost cannot be paid: a Mulldrifter
      with three lands untapped is a Divination, and a play offered only after "can you afford
      {4}{U}" had already skipped the card would be offered exactly when nobody needs it.

      Which is also what makes these the kicker's opposite rather than its siblings. A kicker is a
      second play that can only ever be *more* expensive, so offering it late costs nothing; these
      are cheaper, and everything cheap has to be offered before the expensive question is asked.

      Its own targets, asked here rather than borrowed from below for the same reason: the code
      below has not run yet. `specsFor` and `playableTargets` are the same two calls the ordinary
      cast makes, so the two plays point at the same things.

      From the hand only, and never beside a cast that has already replaced the cost: a card cast
      with flashback is cast for its flashback cost, and one offered by a cascade is cast for
      nothing. Nothing in the pool has either keyword and any of those, and a card that did would
      be being cast for two costs at once. A card with evoke *and* dash would be offered twice
      here, which is also what the rules say happens.
    */
    const alternatives = flashback || escape || foretold || fromCommand || fromAdventure || offered
      ? []
      : [
        /*
          What each keyword costs besides the mana, said out loud on the play.

          A player reading "Cast Mulldrifter for {2}{U}" and then watching it die would have been
          misled by the table rather than by the card, and the same is true of a 3/1 that attacks
          and then disappears. Two keywords, one shape, and the difference between them is this
          sentence — so it lives here with the cost rather than in two copies of the code below.
        */
        ...(script?.evoke === undefined ? [] : [{
          flag: 'evoked' as const,
          cost: script.evoke.cost,
          note: `evoke cost (${script.evoke.cost}, sacrificed as it arrives)`,
          specs: specsFor(script),
        }]),
        ...(script?.dash === undefined ? [] : [{
          flag: 'dashed' as const,
          cost: script.dash.cost,
          note: `dash cost (${script.dash.cost}, hasty, back to your hand at end of turn)`,
          specs: specsFor(script),
        }]),
        /*
          And bestow, which is the one of the three that points at something.

          So the entries carry their own target specs rather than the loop asking `specsFor`: a
          bestowed Boon Satyr enchants a creature where the ordinary one targets nothing, and the
          two plays on the one card have different questions to answer before they can be made.
        */
        ...(script?.bestow === undefined ? [] : [{
          flag: 'bestowed' as const,
          cost: script.bestow.cost,
          note: `bestow cost (${script.bestow.cost}, as an Aura)`,
          specs: [BESTOW_TARGET] as readonly TargetSpec[],
        }]),
        /*
          And spectacle, which is the first of the four that the board has to **earn**.

          The entry is only built when an opponent has already lost life this turn (CR 702.137a), so
          the row is simply absent on a turn nobody has been hit — which is how every other cost
          this engine cannot pay is handled, and better than a greyed-out row nobody can read a
          reason off. "An opponent" is every other seat that is still in the game: in a pod, a hit
          on anybody but you pays for it.
        */
        ...(script?.spectacle === undefined
          || !state.seats.some((other) => other.index !== seat && !other.eliminated
            && (state.lifeLostThisTurn[String(other.index)] ?? 0) > 0)
          ? []
          : [{
              flag: 'spectacled' as const,
              cost: script.spectacle.cost,
              note: `spectacle cost (${script.spectacle.cost}, because an opponent has lost life this turn)`,
              specs: specsFor(script),
            }]),
        /*
          And overload, the one of the five that is **dearer** than the printed cast.

          It is in this list rather than beside the kicker it resembles on price because it is an
          alternative cost: it replaces the printed one, where a kicker is paid on top. Being dearer
          costs nothing here — the loop below asks `canAfford` per alternative, so the row is simply
          absent on a turn the overload cost is out of reach, which is the same answer the printed
          cast gets.

          `specs: []` is the point of the keyword: "change each instance of 'target' to 'each'"
          (CR 702.96a) leaves a spell that points at nothing, so this play asks the player no
          questions and gives a ward, a redirection or a protection trick nothing to answer.
        */
        ...(script?.overload === undefined ? [] : [{
          flag: 'overloaded' as const,
          cost: script.overload.cost,
          note: `overload cost (${script.overload.cost}, each instead of one)`,
          specs: [] as readonly TargetSpec[],
        }]),
      ];
    for (const alternative of alternatives) {
      const altChange = costChangeFor(state, seat, def);
      const altCost = withCostChange(parseManaCost(alternative.cost), altChange.generic);
      const altTargets = playableTargets(state, alternative.specs, seat, id);
      if (altCost.unsupported !== undefined || !altTargets.ok
        || !canAfford(poolOf(state, seat), altCost, sources)) continue;
      out.push({
        kind: 'cast', card: id, name: ch.name, [alternative.flag]: true,
        description: `Cast ${ch.name} for its ${alternative.note}`,
        manaCost: alternative.cost,
        ...(altChange.generic === 0
          ? {}
          : { costChange: altChange.generic, costNote: altChange.notes[0] ?? '' }),
        targetSpecs: alternative.specs, candidates: altTargets.candidates,
        isManaAbility: false, sacrificeOptions: [],
      });
    }

    // Flashback and foretell both replace the cost, so everything from here on — affordability, X,
    // the description — is about that cost rather than the printed one.
    /*
      And an offered cast replaces it with whatever the offer says, which is the shortest arm of
      the chain and the only one where the printed cost is not looked at at all: cascade pays
      nothing and madness pays a cost of its own, and both are on the offer rather than on the card.
    */
    const costShown = offered ? state.pendingOfferedCast?.cost ?? ''
      : flashback ? script?.flashback?.cost ?? ''
        // Escape replaces the printed cost like flashback and foretell, which is why it is in the
        // same chain: the mana half of "Escape—{2}{R}{R}, Exile three other cards" is the whole of
        // what this spell costs in mana, and the card half is counted separately below.
        : escape ? script?.escape?.cost ?? ''
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
    /*
      And the other half of an escape cost, which is paid in cards (CR 702.139).

      Checked here beside the sacrifice for the same reason and by the same rule (CR 601.2h): a
      cost you cannot pay is not one you may pay, so a Phoenix of Ash with two other cards in the
      graveyard is not offered at all rather than offered and refused. `graveyardFodder` is asked
      rather than the zone being counted, because the two can differ — it excludes the card doing
      the escaping, which is what makes "three *other* cards" mean what it says.
    */
    const escapeFodder = escape && script?.escape !== undefined
      ? graveyardFodder(state, seat, id, script.escape.exile)
      : [];
    if (escape && script?.escape !== undefined && escapeFodder.length < script.escape.exile) {
      why(id, `escape asks for ${script.escape.exile} other cards in your graveyard`);
      continue;
    }
    // The tax is generic mana on top of the printed cost (CR 903.8), and it only applies to a
    // cast from the command zone.
    const taxed: ManaCost = fromCommand && tax > 0
      ? { ...printed, generic: printed.generic + tax }
      : printed;
    /*
      And what the permanents on the table do to it: an Electromancer taking {1} off, a Thalia
      putting {1} on. Applied here, where affordability is judged, and again in `castSpell`, where
      the mana is actually taken — through the same function, so the two cannot drift apart.
    */
    const change = costChangeFor(state, seat, def);
    const cost: ManaCost = withCostChange(taxed, change.generic);
    /*
      Delve, which takes generic mana off the cost and pays for it out of the graveyard
      (CR 702.112).

      Before the affordability question rather than after it, because the whole point of the
      mechanic is that the spell is affordable *because* of the cards: a Gurmag Angler asked
      "can you pay {6}{B}" would be blocked on turn four with eleven cards in the graveyard and a
      swamp untapped. `delvePlan` is what `castSpell` recomputes, so the offer and the payment
      cannot disagree — the rule convoke established.
    */
    const delved = script?.delve === true ? delvePlan(state, seat, cost, sources) : null;
    if (script?.delve === true && delved === null) {
      why(id, 'not enough mana, counting every land you could tap and every card you could delve');
      continue;
    }
    /** The cost actually being paid in mana: delve has already come off it. */
    const payable: ManaCost = delved?.cost ?? cost;
    /*
      Convoke widens what may pay for this one spell, so affordability is asked of the plan rather
      than of the lands alone — and the plan is what `castSpell` recomputes, so the offer and the
      payment cannot disagree.
    */
    const convoked = script?.convoke === true ? convokePlan(state, seat, payable, sources) : null;
    if (script?.convoke === true && convoked === null) {
      why(id, 'not enough mana, counting every land you could tap and every creature you could convoke');
      continue;
    }
    /*
      Affordability, asked of everything with a price on it.

      A cascade hit is castable off an empty board with every land tapped, which is most of what
      that keyword is worth — so an offer with no cost skips this. A madness cast has a cost and is
      asked like any other: a Fiery Temper discarded with no red mana up is not a play, and the
      card goes to the graveyard instead (CR 601.2h).
    */
    if ((!offered || costShown !== '') && convoked === null
      && !canAfford(poolOf(state, seat), payable, sources)) {
      why(id, 'not enough mana, counting every land you could still tap');
      continue;
    }
    /*
      The half of the cost that is paid in cards, said out loud on the play.

      Escape's count is printed on the card; delve's is whatever the plan worked out, and both are
      the same kind of thing to the player reading the offer — mana is not all this is going to
      cost. Which cards they are is left out on purpose: they are recomputed as the spell is cast,
      and an offer that named them would be promising something the payment is not bound to.
    */
    const exilesOn = escape && script?.escape !== undefined
      ? { escape: true as const, exiles: script.escape.exile }
      : delved !== null && delved.exiled.length > 0 ? { exiles: delved.exiled.length } : {};
    const taxOn = fromCommand && tax > 0 ? { commanderTax: tax } : {};
    // Only when it actually moved the number: a Thalia taxing a creature spell changes nothing,
    // and a note saying so would be noise on every card in the deck.
    const changeOn = cost.generic === taxed.generic
      ? {}
      : { costChange: cost.generic - taxed.generic, costNote: change.notes[0] ?? '' };
    // X at zero is a legal cast of an X spell and sometimes the only one available, so a cost with
    // {X} is offered whenever the rest of it can be paid; `xMax` says how high the player may go.
    const xOn = payable.x ? { xMax: maxAffordableX(poolOf(state, seat), payable, sources) } : {};

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
          description: `${offered ? (costShown === '' ? 'Cast for free' : `Cast for ${costShown}`) : 'Cast'} ${ch.name}`
            + ` — ${chosen.map((m) => m.description).join('; and ')}`,
          manaCost: costShown, ...taxOn, ...changeOn, ...xOn, ...exilesOn,
          modes, targetSpecs: specs, candidates,
          ...(half === undefined ? {} : { half }),
          ...(offered ? { offered: true } : {}),
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
    /*
      An offered cast is named for what it is rather than for where it is.

      The card is sitting in exile, but "from exile" is not what the player needs to read off this
      row — the pile it came out of is named in the prompt above it, and what is new here is that
      the spell costs nothing. Its own line rather than another arm of the chain below, which is
      about which *cost* is being paid.
    */
    const castLabel = offered
      ? (costShown === ''
          ? `Cast ${ch.name} without paying its mana cost`
          : `Cast ${ch.name} for ${costShown}`)
      : flashback
        ? `Cast ${ch.name} from your graveyard (flashback ${costShown})`
        : escape
          // The cards as well as the mana, because the mana is the cheap half: a player reading
          // "escape {2}{R}{R}" and nothing else would not know the graveyard is about to empty.
          ? `Cast ${ch.name} from your graveyard (escape ${costShown}, exiling ${script?.escape?.exile ?? 0})`
          : foretold
            ? `Cast ${ch.name} from exile (foretold ${costShown})`
            : fromAdventure
              // Named as coming back, because that is the half of the card the player has not
              // seen in play yet and a bare "Cast Merfolk Secretkeeper" from exile reads as a bug.
              ? `Cast ${ch.name} from exile (back from its adventure)`
              : fromCommand && tax > 0
                ? `Cast ${ch.name} (+{${tax}} tax)`
                // Delve the same way convoke is: the count, because the cards are the engine's
                // choice and "delving 6" is what the player needs to read off the offer.
                : `Cast ${ch.name}${convokeNote}${delved !== null && delved.exiled.length > 0
                  ? ` (delving ${delved.exiled.length})` : ''}`;
    out.push({
      kind: 'cast', card: id, name: ch.name,
      description: castLabel,
      manaCost: costShown, ...taxOn, ...changeOn, ...xOn, ...exilesOn,
      targetSpecs: specs, candidates,
      ...(flashback ? { flashback: true } : {}),
      ...(foretold ? { foretold: true } : {}),
      ...(offered ? { offered: true } : {}),
      ...(half === undefined ? {} : { half }),
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
    const kicker = flashback || escape || foretold ? undefined : script?.kicker;
    if (kicker !== undefined) {
      const withKicker = parseManaCost(`${def?.manaCost ?? ''}${kicker.cost}`);
      const kickedCost: ManaCost = withCostChange(
        fromCommand && tax > 0
          ? { ...withKicker, generic: withKicker.generic + tax }
          : withKicker,
        change.generic,
      );
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

    /*
      And buyback, which is the kicker's shape at a different price for a different thing.

      Only on an **instant or a sorcery**: a permanent spell resolving becomes a permanent and never
      leaves the stack for a graveyard at all, so the extra mana would buy nothing — and a row that
      charges for nothing is worse than no row. The cast refuses it on the same grounds, because a
      table and an engine disagreeing about a play is the one bug this file exists to prevent.
    */
    const buyback = flashback || escape || foretold ? undefined : script?.buyback;
    const leavesForAGraveyard = hasType(ch.typeLine, 'instant') || hasType(ch.typeLine, 'sorcery');
    if (buyback !== undefined && leavesForAGraveyard) {
      const withBuyback = parseManaCost(`${def?.manaCost ?? ''}${buyback.cost}`);
      const boughtCost: ManaCost = withCostChange(
        fromCommand && tax > 0
          ? { ...withBuyback, generic: withBuyback.generic + tax }
          : withBuyback,
        change.generic,
      );
      if (withBuyback.unsupported === undefined
        && canAfford(poolOf(state, seat), boughtCost, sources)) {
        out.push({
          kind: 'cast', card: id, name: ch.name, buyback: true,
          description: `Cast ${ch.name} with ${buyback.description.toLowerCase()}`,
          manaCost: `${def?.manaCost ?? ''}${buyback.cost}`, ...taxOn,
          ...(boughtCost.x ? { xMax: maxAffordableX(poolOf(state, seat), boughtCost, sources) } : {}),
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: victims,
        });
      }
    }

    /*
      And replicate, one play per count the mana will cover (CR 702.56).

      Capped at four rather than left to the pool, and the cap is about the *list* rather than about
      the rules: a Pyromatics with eleven Mountains up would otherwise put eleven near-identical
      rows in front of the player, and the eleventh is not a play anybody is choosing between. Four
      is past the top of what either card in this pool is cast for.

      Each count is priced from scratch rather than by adding to the last, because a cost is parsed
      as a whole: `{1}{R}{1}{R}` is two generic and two red, and a loop that added numbers would get
      the coloured half wrong.
    */
    const replicate = flashback || escape || foretold ? undefined : script?.replicate;
    if (replicate !== undefined) {
      for (let times = 1; times <= 4; times += 1) {
        const text = `${def?.manaCost ?? ''}${replicate.cost.repeat(times)}`;
        const parsed = parseManaCost(text);
        if (parsed.unsupported !== undefined) break;
        const cost = withCostChange(
          fromCommand && tax > 0 ? { ...parsed, generic: parsed.generic + tax } : parsed,
          change.generic,
        );
        if (!canAfford(poolOf(state, seat), cost, sources)) break;
        out.push({
          kind: 'cast', card: id, name: ch.name, replicate: times,
          description: `Cast ${ch.name} with replicate x${times}`,
          manaCost: text, ...taxOn,
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: victims,
        });
      }
    }

  }
  return { plays: out, blocked };
}

function activatablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): LegalPlay[] {
  const splitSecond = splitSecondHeld(state);
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
    ...listAt(state, zoneKey(seat, 'battlefield'))
      .map((id) => ({ id, zone: 'battlefield' as const })),
    ...listAt(state, zoneKey(seat, 'hand')).map((id) => ({ id, zone: 'hand' as const })),
    /*
      And the graveyard, which unearth is activated from (CR 702.84a).

      The third zone and the same rule as the other two: an ability is skipped unless the card is
      in the zone its own cost implies, so a Dregscape Zombie's unearth is offered only while the
      Zombie is in the graveyard and its 2/1 body is offered only from the hand.
    */
    ...listAt(state, zoneKey(seat, 'graveyard')).map((id) => ({ id, zone: 'graveyard' as const })),
  ];

  for (const { id, zone } of reachable) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    // Face down is face down: no name, no types, no abilities to activate (CR 707.2).
    if (isFaceDownPermanent(inst)) continue;
    /*
      Nor has a permanent that has lost all abilities got any to activate (CR 613.1f).

      Only on the battlefield, because that is the only zone a continuous effect reaches: this loop
      also walks the hand and the graveyard for cycling, unearth, embalm and ninjutsu, and a card
      there is not something a Turn to Frog has ever been pointed at.
    */
    if (zone === 'battlefield' && allAbilitiesLost(state, inst)) continue;
    const script = scriptFor(state.cardDefs[inst.defKey]?.name);
    const ch = characteristicsOf(state, inst);
    const abilities: readonly AbilityDef[] = script?.abilities ?? [];

    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      /*
        Which zone this ability is used from, read off its cost.

        Cycling discards the card, so it is used from the hand; unearth and embalm are paid out of
        the graveyard; ninjutsu is used from the hand and **does not spend the card** — it puts it
        onto the battlefield instead, which is the first ability here whose source survives its own
        activation in the zone it was activated from.
      */
      const wants = ability.cost.discardSelf === true || ability.cost.returnsUnblockedAttacker === true
        ? 'hand'
        : ability.cost.fromGraveyard === true ? 'graveyard' : 'battlefield';
      if (wants !== zone) continue;
      /*
        Split second (CR 702.19): a mana ability still works, and nothing else does.

        The exception is written into the rule and it earns its place — a seat that tapped a land to
        hold up an answer can still tap the rest, and `produces` is exactly the flag that says an
        ability is a mana ability, the same one `isManaAbility` is built from below.
      */
      if (splitSecond && ability.produces === undefined) continue;
      if (ability.sorcerySpeed && !sorcerySpeed) continue;
      // "Activate only if …" — monstrosity's one-shot clause, and the reason the Lion's ability
      // disappears from the table once it has been paid for. See `AbilityDef.activateOnlyIf`.
      if (ability.activateOnlyIf !== undefined && !ability.activateOnlyIf(state, id, seat)) continue;
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
      // Energy is the same rule again, one zone out: the counters are on the **player** rather
      // than on the permanent (CR 122.1), so a Longtusk Cub with one energy in the pool shows no
      // growth ability at all instead of one that would be refused.
      if (ability.cost.energy !== undefined && energyOf(state, seat) < ability.cost.energy) continue;
      if (ability.cost.mana
        && !canAfford(poolOf(state, seat), parseManaCost(ability.cost.mana), sources)) continue;
      // Life is a cost like any other: an ability you cannot pay for is not offered, which is why
      // a Mana Confluence stops making mana at one life and a City of Brass does not.
      if (ability.cost.life !== undefined && (state.seats[seat]?.life ?? 0) <= ability.cost.life) continue;
      // An ability whose cost is a sacrifice is not activatable with nothing to sacrifice.
      const victims = sacrificeOptions(state, seat, id, ability.cost);
      if (ability.cost.sacrifice !== undefined && victims.length === 0) continue;
      /*
        Ninjutsu, which is the same rule about a different list — and the list is the timing
        (CR 702.49a).

        An unblocked attacker exists only once the defending player has finished declaring blockers,
        so `unblockedAttackersOf` is empty before that and the ability simply is not offered. No
        separate step check: the one fact the cost needs is the one fact that says when it may be
        paid, which is the shape every other cost here already has.
      */
      const ninjas = ability.cost.returnsUnblockedAttacker === true
        ? unblockedAttackersOf(state, seat)
        : [];
      if (ability.cost.returnsUnblockedAttacker === true && ninjas.length === 0) continue;

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
        ...(zone === 'hand' ? { fromHand: true } : {}),
        ...(zone === 'graveyard' ? { fromGraveyard: true } : {}),
        targetSpecs: specs, candidates, isManaAbility: ability.produces !== undefined,
        sacrificeOptions: victims,
        // Which kind of cost that list is for, read off the cost rather than guessed from the list.
        ...(ability.cost.sacrifice === 'artifact' ? { sacrificeKind: 'artifact' as const } : {}),
        ...(ninjas.length === 0 ? {} : { returnOptions: ninjas }),
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

/**
 * What the permanents on the table do to the cost of one spell (CR 601.2f).
 *
 * **One function, two callers**, which is the whole point of it being here rather than written out
 * twice: `legalActions` uses it to decide what a cast costs and whether it is affordable, and
 * `castSpell` uses it to decide what to charge. A table that offered a Lightning Bolt for nothing
 * and then took a mana for it would be a table nobody could trust, and the way this engine stops
 * that is the same way it stops it for convoke, crew and morph — the offer and the payment ask the
 * same question of the same state.
 *
 * Only **generic** mana moves, which is the rule and not a simplification: a cost reduction never
 * touches a coloured requirement, so a Goblin Electromancer makes a Counterspell cost `{U}{U}`
 * still and an Arc Lightning cost `{1}{R}` instead of `{2}{R}`. The total is floored at nought
 * generic for the same reason — a reduction can empty the generic part and no further.
 *
 * Increases and reductions are **netted and floored once**, which is the same answer the rules'
 * order gives (CR 601.2f: increases, then reductions) because the floor only applies at the end:
 * a Thalia and an Electromancer together leave a {1}{R} instant at {1}{R}, and two Electromancers
 * take a {1}{R} to {R} and stop. They are counted separately all the same, so that the day a card
 * cares *which* modifiers applied — "costs {1} less for each" wants a count, not a total — the
 * number it needs is already here.
 *
 * Face-down permanents contribute nothing: a creature cast face down is a 2/2 with no abilities
 * (CR 707.2), and an Electromancer hiding under a morph is doing nothing for anybody.
 *
 * **One cast this does not reach yet, and deliberately:** the {3} of casting a creature *face
 * down*, which is paid by its own path in `castSpell` and offered by its own branch above. For the
 * two cards in the pool the answer is the same either way — a face-down cast is a creature spell,
 * which Thalia does not tax and the Electromancer does not cheapen — so wiring it would be a change
 * with nothing behind it. A Sphere of Resistance, which taxes every spell, would be the card that
 * needs it, and the offer and the payment would both have to learn it in the same commit.
 */
export function costChangeFor(
  state: GameState, seat: SeatIndex, def: CardDef | undefined,
): { readonly generic: number; readonly notes: readonly string[] } {
  if (def === undefined) return { generic: 0, notes: [] };
  let up = 0;
  let down = 0;
  const notes: string[] = [];
  for (const other of state.seats) {
    for (const id of listAt(state, zoneKey(other.index, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) continue;
      const script = scriptFor(state.cardDefs[inst.defKey]?.name);
      for (const mod of script?.costModifiers ?? []) {
        const mine = other.index === seat;
        if (mod.whose === 'controller' && !mine) continue;
        if (mod.whose === 'opponents' && mine) continue;
        if (!mod.applies(state, seat, def)) continue;
        if (mod.generic >= 0) up += mod.generic;
        else down -= mod.generic;
        notes.push(mod.description);
      }
    }
  }
  /*
    And the reduction printed on the **spell itself**: affinity (CR 702.41a).

    The mirror of everything above it. A Goblin Electromancer is a permanent on the battlefield
    changing what *other* spells cost; affinity is a word on the card being cast, reading its own
    caster's board. One function answers both because the question a caller asks is the same —
    "what does this cost here, for this seat" — and folding it in is what gets every caller at once:
    the printed cost, an alternative cost, and the payment that has to agree with the offer.

    Counted off the board rather than from a static, because that is what the keyword says: the
    number is however many artifacts the caster controls *as the cost is computed*, so a Frogmite
    offered at {1} with three artifacts out is offered at {4} the moment they are gone. Generic
    only, like every other reduction here, and floored with them below.
  */
  const own = scriptFor(def.name)?.affinity;
  if (own !== undefined) {
    const n = listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) return false;
      return hasType(characteristicsOf(state, inst).typeLine, 'artifact');
    }).length;
    if (n > 0) {
      down += n;
      notes.push(`affinity for artifacts: {${n}} less`);
    }
  }
  if (up === 0 && down === 0) return { generic: 0, notes: [] };
  return { generic: up - down, notes };
}

/** Applies a cost change to a parsed cost, taking generic down to nought and no further. */
export function withCostChange(cost: ManaCost, change: number): ManaCost {
  if (change === 0) return cost;
  const generic = Math.max(0, cost.generic + change);
  return generic === cost.generic ? cost : { ...cost, generic };
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
    && state.pendingPayment === null && state.pendingOfferedCast === null
    && state.pendingDredge === null
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
    const specs = object === undefined ? [] : abilityTargetSpecs(state, object);
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
        ...(decision.counters === true ? { counters: true as const } : {}),
        candidates: decision.candidates, min: decision.min, max: decision.max,
      }
    : null;

  const offer = state.pendingOfferedCast;
  const mustCastOffered: LegalActions['mustCastOffered'] = offer !== null && offer.seat === seat
    ? {
        prompt: offer.prompt,
        card: offer.card,
        source: offer.source,
        cost: offer.cost ?? '',
        bottom: (offer.bottom ?? []).length,
        ...(offer.mandatory === true ? { mandatory: true } : {}),
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

  const dredge = state.pendingDredge;
  const mustDredge: LegalActions['mustDredge'] = dredge !== null && dredge.seat === seat
    ? { prompt: dredge.prompt, card: dredge.card, mill: dredge.mill }
    : null;

  const empty: LegalActions = {
    seat, step: state.step, hasPriority, isActivePlayer: state.activeSeat === seat,
    canPass: false, passLabel: '', plays: [], attackers: [], mustAttack: [], attackAims: [],
    blockers: [], mustOrder: [],
    mustDiscard, mustDeclare, mustSettleHand, bottomOwed: bottomOwed(state, seat), mustChoose,
    mustDecide, mustPay, mustCastOffered, mustDredge, blocked: [],
    pacts: pactOptions(state, seat),
    pool: poolOf(state, seat),
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
  /*
    And so does a dredge, which is the one of these that stops the table over a card nobody cast.

    There is nothing on the stack and nothing targeted — a *draw* is waiting, and until this is
    answered it stays waiting. Two buttons rather than a pass, the same shape as a ward and for the
    same reason: declining is not a gesture the table already has a meaning for, it is the other
    half of the question, and `auto:dredge` carries which half was pressed.
  */
  if (dredge !== null) {
    return mustDredge === null ? empty : { ...empty, passLabel: `Dredge ${dredge.mill}` };
  }
  /*
    And so does an offered cast on offer, which is the one of these five that is answered with a *play*.

    The seat it belongs to is given its casts and nothing else — no lands, no abilities, no attacks
    — because the table is stopped mid-resolution and those moves are not available there. Passing
    is declining, which is why `canPass` is true and the button says so: "you may cast it" has two
    answers and the second one is the one every other table gesture already means.

    Everybody else is given nothing at all, the same as for a ward: there is one move at this table
    and it is not theirs.
  */
  if (offer !== null) {
    if (offer.seat !== seat) return empty;
    const offered = castablePlays(state, seat, sources).plays.filter((play) => play.offered === true);
    /*
      Unless the cast is **mandatory**, which is suspend's and nothing else's (CR 702.62c).

      Three of the four offers are permissions and declining is a real answer. A suspended card
      whose last time counter has come off is not a permission — the rules say you cast it — so
      there is no pass to offer, and the only move at this table is the cast. A suspended card that
      genuinely cannot be cast never gets here: `settleOffer` takes the offer back before anybody is
      asked, the same way it does for a madness cost nobody can pay.
    */
    if (offer.mandatory === true) return { ...empty, plays: offered };
    return { ...empty, canPass: true, passLabel: 'Decline', plays: offered };
  }
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
