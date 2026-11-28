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
import { defKeyFor, isFaceDownPermanent, zoneKey, type CardDef, type CardInstance } from './cards.js';
import { commanderTaxFor, listAt } from './cardActions.js';
import {
  allAbilitiesLost, landTypesSet, cardHasSubtype, characteristicsOf, commanderIdentity, grantedAbilitiesOn, hasSubtype, hasType, parseTypeLine, type GrantedTriggerRef, type TypeLine,
} from './characteristics.js';
import { emergeOptions, conspireOptions, casualtyOptions,
  abilityUseKey, atActivationTiming, atSorcerySpeed, bottomOwed, grantedAbilityFor, modeCombinations,
  discardOptions, modeTargetSpecs, modesOf, pendingDeclaration, sacrificeOptions, sacrificeWords, stackTop, unblockedAttackersOf,
} from './automation.js';
import {
  canBlock, damageOrdersOwed, forcedAttackers, legalAttackers, legalBlockers, legalDefenders,
} from './combat.js';
import { BOUND_MANA_KEY, canPayLife, energyOf, evidencePlan, lifeLocked, paymentWords, poolOf, preparedCopyOf } from './effects.js';
import { spendRestriction } from './spending.js';
import {
  addMana, canAfford, maxAffordableX, parseManaCost, reducedCostText,
  type Color, type ManaCost, type ManaPool, type ManaType,
} from './mana.js';
import { abilityTargetSpecs } from './scripts.js';
import { scriptForCard } from './derive.js';
import { AWAKEN_LAND,
  FORETELL_COST, MORPH_COST, isChoiceDecision, morphCostText, producedBy,
  type AbilityCost, type AbilityDef, type CardScript, type CastLimit, type PaymentFor, type TargetSpec,
} from './scriptTypes.js';
import { BESTOW_TARGET, legalTargets } from './targeting.js';
import { PACT_KINDS } from './pacts.js';
import { MAIN_STEPS, type DecisionZone, type Step, type Target } from './turnTypes.js';
import type { GameState, PactKind, SeatIndex } from './types.js';

/**
 * How long a permission to play a card out of exile lasts, in the words the play row shows (D583).
 * The deadline is the half the player has to act on, so every such row says it.
 */
const PLAY_FROM_EXILE_UNTIL: Readonly<Record<
  NonNullable<CardInstance['playFromExile']>['through'], string
>> = {
  'this-turn': 'this turn only',
  'your-next-turn': 'until the end of your next turn',
  'your-next-end-step': 'until your next end step',
  plotted: 'plotted, without paying its mana cost',
  warped: 'warped, on a later turn',
  'while-exiled': 'for as long as it remains exiled',
};

/** One thing a player could do, with everything the UI needs to offer it. */
export interface LegalPlay {
  /**
   * `turnUp` is the odd one: a special action rather than a cast or an ability (CR 702.37b), which
   * is exactly why it is its own kind — it uses no stack, so a table that drew it as an ability
   * would be promising a window to respond that does not exist.
   */
  readonly kind: 'land' | 'cast' | 'activate' | 'turnUp' | 'foretell' | 'suspend' | 'plot' | 'unlock';
  /** The Room door an `unlock` play opens (D1298): a face index. */
  readonly door?: number;
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
  /**
   * Coloured mana the table adds to this spell's cost (D1313): a Leech's "{W}". Shown beside the
   * printed cost, as `costChange` is, so the play does not read cheaper than it is.
   */
  readonly costExtra?: string;
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
  /**
   * The X to open the question on, when the card says its largest X is not its best: see
   * `CardScript.bestX`. Absent for every other X play, where the table opens on `xMax`.
   */
  readonly xDefault?: number;
  /**
   * Generic mana each target **beyond the first** adds to this cast: `CardScript.extraTargetCost`.
   *
   * On the play so a table can keep X and the targets inside one budget — `xMax` is what the seat
   * can pay on top of the rest of the cost, and every extra target spends one of it.
   */
  readonly extraTargetCost?: number;
  /** And its coloured symbols (D1357, Strive): `CardScript.extraTargetColoured`. */
  readonly extraTargetColoured?: readonly ManaType[];
  readonly abilityIndex?: number;
  /**
   * Which card **defines** this ability, for an ability a continuous effect handed this permanent
   * (CR 113.6) — and absent on a printed one, which is almost every play.
   *
   * It has to travel with the play because `abilityIndex` means something different in the two
   * cases: the grantor's `grantedAbilities` rather than this card's own `abilities`. A client or
   * the bot copies it onto the action unchanged; `autoActions` re-derives the grant from the board
   * and refuses a reference the permanent no longer has.
   */
  readonly grantedBy?: GrantedTriggerRef;
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
  /** Which of a double kicker's kickers this play pays (D1099); absent is the first. */
  readonly kickedWith?: 'first' | 'second' | 'both';
  /** How many times this play pays a multikicker (D1100). */
  readonly kickCount?: number;
  /** Set on the play that pays casualty (D923): `sacrificeOptions` are the creatures it may take. */
  readonly casualty?: boolean;
  /** Set on the play that pays conspire (D926). */
  readonly conspire?: boolean;
  /** Set on the play that casts for the emerge cost (D929): `sacrificeOptions` are its creatures. */
  readonly emerged?: boolean;
  /** Set on the play that casts for the awaken cost (D932): its last target spec is the land. */
  readonly awakened?: boolean;
  /** Set on the play that casts the card as a prototype (D934). */
  readonly prototyped?: boolean;
  /** Cast for its impending cost (D1097). */
  readonly impended?: boolean;
  /**
   * Set on the play that casts a copy of a prepared permanent's spell (D978): `card` is the
   * permanent and `half` is 0, its spell face. See `preparedCopyOf`.
   */
  readonly preparedCopy?: boolean;
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
   * Set on a play that casts the card out of its owner's graveyard by **retrace** (CR 702.81, D599):
   * its printed cost, and a land card discarded from hand as an additional cost — whose candidates
   * travel as `discardOptions`. It goes back to the graveyard when it resolves, as escape's does.
   */
  readonly retrace?: boolean;
  /** A split card's aftermath half, from the graveyard (D1296). */
  readonly aftermath?: true;
  /** Cast out of the graveyard under a permanent's permission (D1287): that permanent's id. */
  readonly yardBy?: string;
  /** Both halves of a fuse split card together, from the hand (D1295). */
  readonly fuse?: true;
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
  /** Set on the play that casts the card for nothing because you control a commander (D653). */
  readonly commanderFree?: boolean;
  /**
   * Set on the play that casts the card for its pitch cost (D691): one card of the printed colour
   * exiled from your hand instead of the mana, chosen from `discardOptions` and sent as
   * `discarded`. `pitchWords` names the card for the table ("blue card").
   */
  readonly pitchCast?: boolean;
  readonly pitchWords?: string;
  /** Set on the play that casts the card for its printed mana or life alternative (D1251). */
  readonly altCast?: boolean;
  /** Cast off the top of the library for life equal to its mana value (D731): Bolas's Citadel. */
  readonly payLifeFromTop?: boolean;
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
   * On a shock land's play: this row pays the life, and the land enters untapped (D587). The same
   * land is offered again without it, entering tapped. See `CardScript.payLifeToEnterUntapped`.
   */
  readonly payLife?: true;
  /**
   * On a land that chooses a colour as it enters (D642): this row's colour. The land is offered
   * once per colour it may choose, the way a shock land is offered twice. See `AutoPlayLandAction.choose`.
   */
  readonly choose?: string;
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
  readonly sacrificeKind?: 'artifact' | 'artifact-or-creature';
  /**
   * What the sacrifice cost eats, in words (D609): "land", "token", "artifact or land", "Forest".
   * Set on every play whose cost sacrifices something, so the table can ask in the cost's own words
   * rather than assume a creature; `sacrificeKind` above stays the bot's narrower signal.
   */
  readonly sacrificeWords?: string;
  /**
   * How many of `sacrificeOptions` the cost sacrifices, when it is more than one (D732): "Sacrifice
   * two creatures", Bolas's Citadel's ten. The activation sends them as `sacrifices`.
   */
  readonly sacrificeCount?: number;
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
  /**
   * The cards in hand that may be **discarded** to pay this ability's cost, when it says "Discard
   * a card" (D579) — the third list of its kind, and its own for the reason `returnOptions` is:
   * the table has to ask "which card do you want to discard", not "which creature do you want to
   * lose". Absent for every other ability.
   */
  readonly discardOptions?: readonly string[];
  /** A counted discard (D1330): this many of `discardOptions`, sent as `discards`. */
  readonly discardCount?: number;
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
    /** The cards being looked at, when that is more than `candidates`. See `pendingDecision.looked`. */
    readonly looked?: readonly string[];
    /** Where the picked cards go, when it is not the bottom. See `pendingDecision.picksGoTo`. */
    readonly picksGoTo?: 'graveyard' | 'hand' | 'top';
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
    /** Cards to discard to pay (D1327), chosen from the hand and sent as `auto:pay`'s `discarded`. */
    readonly discard?: number;
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
  readonly mustOrder: readonly {
    readonly attacker: string;
    readonly blockers: readonly string[];
    /** It may assign its damage as though it weren't blocked instead (D770). */
    readonly mayGoUnblocked?: true;
  }[];
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
  /**
   * Which card **defines** the ability `abilityIndex` names, for one a continuous effect handed
   * this permanent (CR 113.6), and absent for a printed one.
   *
   * Carried although the auto-tapper never activates the ability — `tapSources` taps the permanent
   * and adds the mana itself — because without it `abilityIndex` is a number whose meaning depends
   * on a fact this entry does not state, and the next reader of it would have no way to know.
   */
  readonly grantedBy?: GrantedTriggerRef;
  readonly choose?: boolean;
  /** With `choose`: mana every tap adds beside the choice (D1088). See `ManaSource.extra`. */
  readonly extra?: readonly ManaType[];
  /** Life the tap costs, for a land that charges you for the colour. */
  readonly life?: number;
  /** Using it sacrifices it: a Treasure, which makes one mana once. See `ManaSource.sacrifices`. */
  readonly sacrifices?: boolean;
  /** Its mana may only pay for what it was listed for. See `ManaSource.restricted` (D595). */
  readonly restricted?: true;
}

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

/**
 * The permanents a "tap N untapped <kind> you control" cost taps (D610), or `null` when there are
 * not enough. Untapped permanents of the kind, the source last — so an ability on a creature that
 * may tap itself does so only when nothing else will — and otherwise the weakest first, crew's rule.
 */
/** Whether this seat controls a commander on the battlefield (D653): "if you control a commander". */
/**
 * A card's flashback cost, printed or given (D694): its own `flashback`, or — while an effect has
 * given it flashback this turn and it is still in a graveyard — its mana cost (Snapcaster Mage).
 */
export function flashbackCostOf(state: GameState, id: string): string | undefined {
  const inst = state.instances[id];
  if (inst === undefined) return undefined;
  const def = state.cardDefs[inst.defKey];
  const flashback = scriptForCard(def)?.flashback;
  // Jump-start pays the card's own mana cost (D908).
  if (flashback?.ownManaCost === true) return def?.manaCost ?? '';
  const printed = flashback?.cost;
  if (printed !== undefined) return printed;
  return inst.zone === 'graveyard' && inst.flashbackGrantedTurn === state.turn ? def?.manaCost ?? '' : undefined;
}

/**
 * The `{T}: Add {X}` a basic land type gives a land (CR 305.6), for the types it has now (D699).
 * Kept here rather than imported from `fromCardData`, whose own copy reads printed type lines,
 * because importing that module here closes an import cycle.
 */
const BASIC_TYPE_MANA: Readonly<Record<string, ManaType>> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G',
};
function typeGrantedMana(subtypes: readonly string[]): AbilityDef[] {
  return [...new Set(subtypes.map((s) => BASIC_TYPE_MANA[s.toLowerCase()]).filter((t): t is ManaType => t !== undefined))]
    .map((t) => ({ cost: { tap: true }, description: `{T}: Add {${t}}.`, produces: [t] }));
}

/**
 * The life an ability's cost takes from this seat (D702): its printed amount, plus one for each
 * colour in the seat's commanders' identity where the cost says so (War Room). Read as the
 * ability is offered and as it is paid.
 */
export function abilityLifeCost(state: GameState, seat: SeatIndex, cost: AbilityCost): number {
  return (cost.life ?? 0) + (cost.lifePerIdentityColour === true ? commanderIdentity(state, seat).length : 0);
}

/** What a spell's mana is being spent on, for a restricted source (D595, D697). */
function payingFor(state: GameState, id: string, def: CardDef | undefined): PaymentFor {
  const inst = state.instances[id];
  return {
    spell: parseTypeLine(def?.typeLine), commander: inst?.isCommander === true,
    // Its colours as they are now (D1399), for "colorless Eldrazi spells".
    ...(inst === undefined ? {} : { spellColors: characteristicsOf(state, inst).colors }),
  };
}

/**
 * Whether a printed alternative of mana or life is open to this seat now (D1251): the land type it
 * names controlled, and the life there to pay without losing the game.
 */
/**
 * The lands an alternative cost returns or sacrifices (D1252): `bouncePlan`'s order, tapped ones
 * first and then the cheapest. `null` when there are too few.
 */
export function landCostPlan(
  state: GameState, seat: SeatIndex, lands: { readonly count: number; readonly subtype: string; readonly basic?: true },
): readonly string[] | null {
  return bouncePlan(state, seat, { count: lands.count, kind: 'land', subtype: lands.subtype, ...(lands.basic === true ? { basic: true as const } : {}) }, '');
}

export function altCostOpen(
  state: GameState, seat: SeatIndex,
  alt: { readonly life?: number; readonly ifControl?: string; readonly lands?: { readonly count: number; readonly subtype: string; readonly basic?: true } },
): boolean {
  if (alt.lands !== undefined && landCostPlan(state, seat, alt.lands) === null) return false;
  if (alt.ifControl !== undefined && !listAt(state, zoneKey(seat, 'battlefield')).some((id) => {
    const inst = state.instances[id];
    return inst !== undefined && characteristicsOf(state, inst).typeLine.subtypes.includes(alt.ifControl!);
  })) return false;
  return canPayLife(state, seat, alt.life ?? 0);
}

/** Colour words, for the pitch's offer (D691). */
const COLOUR_NAMES: Readonly<Record<string, string>> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/**
 * The cards a pitch cost may exile (D691): every **other** card in the caster's hand of that
 * colour, by its printed colours (a card in hand has no others).
 */
export function pitchOptions(state: GameState, seat: SeatIndex, spell: string, colour: string): string[] {
  return listAt(state, zoneKey(seat, 'hand')).filter((id) => id !== spell
    && (state.cardDefs[state.instances[id]?.defKey ?? '']?.colors ?? []).includes(colour));
}

/**
 * Why a spectacle-shaped alternative cost cannot be paid now, or null when it can: spectacle,
 * surge (D928), prowl and freerunning (D935) share one play and one flag and differ only in the
 * condition. Asked by the offer and by `castSpell`, so the two cannot disagree.
 */
export function spectacleRefusal(
  state: GameState, seat: SeatIndex, def: CardDef | undefined, spectacle: NonNullable<CardScript['spectacle']>,
): string | null {
  if (spectacle.surge === true) {
    return (state.spellsCastThisTurnBy[String(seat)] ?? 0) >= 1 ? null
      : 'the surge cost is only payable if you have cast another spell this turn';
  }
  const hits = state.combatHitsThisTurn?.[String(seat)] ?? [];
  if (spectacle.prowl === true) {
    return hits.some((hit) => hit.subtypes.some((type) => cardHasSubtype(def, type))) ? null
      : 'the prowl cost is only payable if a creature of yours sharing a creature type with this spell dealt combat damage to a player this turn';
  }
  if (spectacle.freerunning === true) {
    return hits.some((hit) => hit.commander === true || hit.subtypes.includes('Assassin')) ? null
      : 'the freerunning cost is only payable if an Assassin or a commander of yours dealt combat damage to a player this turn';
  }
  return state.seats.some((other) => other.index !== seat && !other.eliminated
    && (state.lifeLostThisTurn[String(other.index)] ?? 0) > 0) ? null
    : 'the spectacle cost is only payable if an opponent lost life this turn';
}

/**
 * How many more times this turn an ability may be activated (D943): Infinity with no limit, one
 * for "only once each turn", N for "no more than N times each turn", less what was used this turn.
 */
export function usesLeftThisTurn(
  state: GameState, inst: CardInstance, ability: { readonly onceEachTurn?: true; readonly timesEachTurn?: number; readonly onceEver?: true }, key: string,
): number {
  // "Activate only once" / exhaust (D1133): spent for as long as this object exists.
  if (ability.onceEver === true && inst.abilityExhausted?.[key] === (inst.objectSeq ?? 0)) return 0;
  const limit = ability.onceEachTurn === true ? 1 : ability.timesEachTurn;
  if (limit === undefined) return Infinity;
  const used = inst.abilityUsedTurn?.[key] === state.turn ? inst.abilityUseCount?.[key] ?? 1 : 0;
  return limit - used;
}

export function controlsACommander(state: GameState, seat: SeatIndex): boolean {
  return listAt(state, zoneKey(seat, 'battlefield')).some((id) => state.instances[id]?.isCommander === true);
}

/** Every live casting limit on the table (D788), with the permanent and seat it comes from. */
function castLimitsInPlay(state: GameState): { readonly limit: CastLimit; readonly from: SeatIndex; readonly name: string; readonly chosenName?: string }[] {
  const out: { limit: CastLimit; from: SeatIndex; name: string; chosenName?: string }[] = [];
  for (const other of state.seats) {
    // Read off the permanents rather than their scripts (D1238), for the name each one chose.
    const emblems = listAt(state, zoneKey(other.index, 'command')).filter((id) => state.instances[id]?.emblem === true);
    for (const id of [...listAt(state, zoneKey(other.index, 'battlefield')), ...emblems]) {
      const inst = state.instances[id];
      if (inst === undefined || inst.faceDown === true || allAbilitiesLost(state, inst)) continue;
      const script = scriptForCard(state.cardDefs[inst.defKey]);
      for (const limit of script?.castLimits ?? []) {
        out.push({ limit, from: other.index, name: script!.name, ...(inst.chosen?.name === undefined ? {} : { chosenName: inst.chosen.name }) });
      }
    }
  }
  return out;
}

/**
 * Why this seat may not cast this spell now because of a permanent's casting limit (D788), or null.
 * `offered` is a cast an effect makes mid-resolution (cascade), which no timing limit reaches.
 */
/**
 * The permanent letting `seat` cast this graveyard card now (D1287), or null: one of the seat's own
 * permanents with `castsFromGraveyard` whose kind the card fits and whose permission is unused this
 * turn, on the seat's own turn, the card in the seat's own graveyard.
 */
export function yardPermission(state: GameState, seat: SeatIndex, id: string): string | null {
  if (state.activeSeat !== seat) return null;
  const inst = state.instances[id];
  if (inst === undefined || inst.zone !== 'graveyard' || inst.zoneSeat !== seat) return null;
  for (const source of listAt(state, zoneKey(seat, 'battlefield'))) {
    const permit = scriptForCard(state.cardDefs[state.instances[source]?.defKey ?? ''])?.castsFromGraveyard;
    if (permit === undefined || !permit.fits(state, id, seat)) continue;
    if (yardSlotFor(state, source, permit, id) !== null) return source;
  }
  return null;
}

/**
 * The key a graveyard cast through `source` would spend (D1288): the permanent's own, or, for a
 * permission with `slots`, the first type of the card's still unused this turn. Null when none is free.
 */
export function yardSlotFor(
  state: GameState, source: string, permit: NonNullable<CardScript['castsFromGraveyard']>, id: string,
): string | null {
  if (permit.slots === undefined) return state.yardCastsUsed?.[source] === state.turn ? null : source;
  const line = parseTypeLine(state.cardDefs[state.instances[id]?.defKey ?? '']?.typeLine);
  const slot = permit.slots.find((type) => hasType(line, type) && state.yardCastsUsed?.[`${source}#${type}`] !== state.turn);
  return slot === undefined ? null : `${source}#${slot}`;
}

/**
 * A card's escape (D1235): its own, or the one an Underworld Breach on its owner's battlefield gives
 * each nonland card in that graveyard, at the card's own mana cost. A card with no mana cost is
 * given none: what it would cost is not something its printing says.
 */
export function escapeOf(state: GameState, id: string): CardScript['escape'] {
  const inst = state.instances[id];
  const def = inst === undefined ? undefined : state.cardDefs[inst.defKey];
  const own = scriptForCard(def)?.escape;
  if (own !== undefined || inst === undefined || def === undefined || inst.zone !== 'graveyard') return own;
  if (hasType(parseTypeLine(def.typeLine), 'land') || (def.manaCost ?? '') === '') return undefined;
  let exile: number | undefined;
  for (const pid of listAt(state, zoneKey(inst.owner, 'battlefield'))) {
    const p = state.instances[pid];
    if (p === undefined || isFaceDownPermanent(p) || allAbilitiesLost(state, p)) continue;
    const grant = scriptForCard(state.cardDefs[p.defKey])?.grantsEscape;
    if (grant !== undefined) exile = Math.min(exile ?? grant.exile, grant.exile);
  }
  return exile === undefined ? undefined : { cost: def.manaCost!, exile };
}

export function castProhibition(
  state: GameState, seat: SeatIndex, isCreature: boolean, offered: boolean, fromHand = true, isArtifact = false,
  spellName?: string, fromZone?: string,
): string | null {
  // Silence and Orim's Chant (D791): barred for the rest of this turn.
  if (state.castBannedTurn?.[String(seat)] === state.turn) return "you can't cast spells this turn";
  // Ranger-Captain of Eos (D803): noncreature spells only.
  if (!isCreature && state.noncreatureBannedTurn?.[String(seat)] === state.turn) return "you can't cast noncreature spells this turn";
  const cast = state.spellsCastThisTurnBy[String(seat)] ?? 0;
  const noncreature = state.spellsCastThisTurnByKind?.[`${seat}:noncreature`] ?? 0;
  const nonartifact = state.spellsCastThisTurnByKind?.[`${seat}:nonartifact`] ?? 0;
  for (const { limit, from, name, chosenName } of castLimitsInPlay(state)) {
    if (limit === 'chosen-name' && chosenName !== undefined && spellName === chosenName) return `${name}: spells named ${chosenName} can't be cast`;
    const theirs = from !== seat;
    if (limit === 'each-one-spell' && cast >= 1) return `${name}: no more than one spell each turn`;
    if (limit === 'you-one-spell' && !theirs && cast >= 1) return `${name}: no more than one spell each turn`;
    if (limit === 'each-one-noncreature' && !isCreature && noncreature >= 1) return `${name}: no more than one noncreature spell each turn`;
    if (limit === 'own-turn-only' && state.activeSeat !== seat) return `${name}: spells only during your own turn`;
    if (limit === 'opponents-sorcery-speed' && theirs && !offered && !atSorcerySpeed(state, seat)) {
      return `${name}: you can cast spells only when you could cast a sorcery`;
    }
    if (limit === 'opponents-no-spells-your-turn' && theirs && state.activeSeat === from) return `${name}: no spells during its controller's turn`;
    if (limit === 'opponents-hand-only' && theirs && !fromHand) return `${name}: you can cast spells only from your hand`;
    if (limit === 'each-one-nonartifact' && !isArtifact && nonartifact >= 1) return `${name}: no more than one nonartifact spell each turn`;
    // Grafdigger's Cage, Kunoros (D1241): flashback, escape, a Yawgmoth's Will, a Future Sight.
    if (limit === 'no-graveyard-casts' && fromZone === 'graveyard') return `${name}: spells can't be cast from graveyards`;
    if (limit === 'no-library-casts' && fromZone === 'library') return `${name}: spells can't be cast from libraries`;
  }
  return null;
}

/**
 * Why this seat may not activate an ability of this permanent now (D788), or null: Grand
 * Abolisher's "During your turn, your opponents can't … activate abilities of artifacts, creatures,
 * or enchantments" — mana abilities included, since the rule says abilities.
 */
export function abilityProhibition(state: GameState, seat: SeatIndex, ch: { readonly typeLine: TypeLine }): string | null {
  const kinds = ['artifact', 'creature', 'enchantment'];
  if (!ch.typeLine.types.some((t) => kinds.includes(t.toLowerCase()))) return null;
  for (const { limit, from, name } of castLimitsInPlay(state)) {
    if (limit === 'opponents-no-abilities-your-turn' && from !== seat && state.activeSeat === from) {
      return `${name}: no abilities of artifacts, creatures or enchantments during its controller's turn`;
    }
  }
  return null;
}

/** The permanents whose static abilities this seat may lean on now: its own, face up, abilities intact. */
function staticsOf(state: GameState, seat: SeatIndex): readonly CardScript[] {
  const out: CardScript[] = [];
  // And its emblems, from the command zone (D734): "You have no maximum hand size".
  const emblems = listAt(state, zoneKey(seat, 'command')).filter((id) => state.instances[id]?.emblem === true);
  for (const id of [...listAt(state, zoneKey(seat, 'battlefield')), ...emblems]) {
    const inst = state.instances[id];
    if (inst === undefined || inst.faceDown === true || allAbilitiesLost(state, inst)) continue;
    const script = scriptForCard(state.cardDefs[inst.defKey]);
    if (script !== undefined) out.push(script);
  }
  return out;
}

/**
 * Whether a permanent this seat controls lets it cast this spell as though it had flash (D800):
 * Leyline of Anticipation and its narrower kin. See `CardScript.flashFor`.
 */
export function flashGranted(state: GameState, seat: SeatIndex, spell: Parameters<NonNullable<CardScript['flashFor']>>[0]): boolean {
  return staticsOf(state, seat).some((script) => script.flashFor?.(spell) === true);
}

/**
 * How many lands this seat may play this turn (CR 305.2): one, plus what an effect handed it this
 * turn (`extraLands`), plus every "you may play an additional land on each of your turns" it
 * controls (D648) — read live, so an Azusa that dies takes her two drops with her.
 */
export function landDropsFor(state: GameState, seat: SeatIndex): number {
  const statics = staticsOf(state, seat).reduce((n, script) => n + (script.additionalLands ?? 0), 0);
  // Everyone's "each player may play an additional land" (D785), from any seat's battlefield.
  const shared = state.seats.reduce((n, _seat, other) => n + staticsOf(state, other as SeatIndex).reduce((m, script) => m + (script.additionalLandsEach ?? 0), 0), 0);
  return 1 + (state.extraLands[String(seat)] ?? 0) + statics + shared;
}

/** Whether this seat may play lands from its graveyard now (D648): Crucible of Worlds. */
export function landsFromGraveyardFor(state: GameState, seat: SeatIndex): boolean {
  return staticsOf(state, seat).some((script) => script.landsFromGraveyard === true);
}

/** Whether this seat's top card is revealed to everybody now (D649): Courser of Kruphix. */
export function topRevealedFor(state: GameState, seat: SeatIndex): boolean {
  return staticsOf(state, seat).some((script) => script.topRevealed === true);
}

/** The permissions this seat has now to cast spells off the top of its library (D731). */
export function spellsFromTopFor(state: GameState, seat: SeatIndex): NonNullable<CardScript['spellsFromTop']> {
  return staticsOf(state, seat).flatMap((script) => script.spellsFromTop ?? []);
}

/** Whether this seat may look at its own top card now (D731): Bolas's Citadel. */
export function lookAtTopFor(state: GameState, seat: SeatIndex): boolean {
  return staticsOf(state, seat).some((script) => script.lookAtTop === true);
}

/** Whether this seat may play a land off the top of its library now (D649). */
export function landsFromTopFor(state: GameState, seat: SeatIndex): boolean {
  return staticsOf(state, seat).some((script) => script.landsFromTop === true);
}

export function tapCostPlan(
  state: GameState, seat: SeatIndex, cost: NonNullable<AbilityCost['tapUntapped']>, source: string,
  sourceTapsItself = false,
): readonly string[] | null {
  const available: { id: string; rank: number }[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    // A cost that also prints {T} taps the source for that, so it cannot be one of these too
    // (cohort: "{T}, Tap an untapped Ally you control").
    if (sourceTapsItself && id === source) continue;
    // "Tap **another** untapped creature" (D645) never taps the source.
    if (cost.other === true && id === source) continue;
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const ch = characteristicsOf(state, inst);
    const kind = cost.kind === 'creature' ? ch.isCreature
      : cost.kind === 'artifact' ? hasType(ch.typeLine, 'artifact')
        : cost.kind === 'artifact-or-creature' ? ch.isCreature || hasType(ch.typeLine, 'artifact')
          : true;
    if (!kind) continue;
    if (cost.subtype !== undefined && !hasSubtype(ch.typeLine, cost.subtype.toLowerCase())) continue;
    available.push({ id, rank: (id === source ? 1000 : 0) + (ch.isCreature ? ch.power : 0) });
  }
  if (available.length < cost.count) return null;
  return available.sort((a, b) => a.rank - b.rank).slice(0, cost.count).map((entry) => entry.id);
}

/**
 * Convoke (CR 702.51) and improvise (CR 702.126): which permanents to tap for a cost, and what is
 * left of it to pay.
 *
 * **One planner for both**, because they are the same mechanic with two parameters. Convoke taps
 * creatures and each one pays a generic pip or a pip of its own colour; improvise taps artifacts
 * and each one pays a generic pip and nothing else — CR 702.126a is "each artifact you control can
 * be tapped to pay {1}", with no colour clause in it at all. Everything else is identical: mana
 * first, the shortfall only, coloured pips before generic, a tapped permanent leaving the mana
 * sources. Improvise as its own function would have been that whole argument copied with one line
 * changed, and the copy is where the two would have drifted apart.
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
 * **A permanent that makes mana is tapped last**, and improvise is what forced that rule into the
 * open. A Sol Ring is both an artifact improvise may tap and a source for {C}{C}, and it cannot be
 * both — so tapping it for one pip throws a mana away, and a board of Sol Ring plus three Crypts
 * against a {5} spell is castable on one assignment (Ring for mana, Crypts for three pips) and
 * short by one on the other. Under battlefield order it was the other. Nothing is lost by the
 * rule either, because every mana pays a generic pip: a source is always worth at least as much
 * tapped for mana as tapped for a cost, so there is no board on which reaching for it first helps.
 * Convoke's own answers do not move — a creature tapping for one mana is worth the same either
 * way — which is why the rule can live in the shared planner rather than in one arm of it.
 *
 * **Summoning sickness does not stop it.** Tapping for convoke is neither attacking nor activating
 * an ability, so a creature that arrived this turn may be tapped for it (CR 702.51a) — the one rule
 * about convoke that is easy to get wrong in the direction of being too strict. The same answer
 * covers improvise, where it is not even a question: an artifact has no summoning sickness to ask
 * about unless it is also a creature, and tapping it here is still neither of the two things
 * CR 302.6 is about.
 *
 * **An artifact creature answers to both rules**, and that is not a special case in here: under
 * `'improvise'` it is an artifact that pays one generic pip, under `'convoke'` it is a creature that
 * may pay a coloured one. No card prints both keywords, so the two readings never meet on one cast.
 *
 * Returns null when even tapping everything eligible cannot cover the cost. `legalActions` and
 * `castSpell` both call this, so there is one answer to "can this be paid for" rather than an offer
 * and a refusal.
 */
export type TapToPayRule = 'convoke' | 'improvise';

export function tapToPayPlan(
  state: GameState, seat: SeatIndex, cost: ManaCost, sources: readonly ManaSourceEntry[],
  rule: TapToPayRule,
): { readonly tapped: readonly string[]; readonly cost: ManaCost } | null {
  const pool = poolOf(state, seat);
  if (canAfford(pool, cost, sources)) return { tapped: [], cost };

  /** Untapped permanents this rule may tap, with the colours each could pay for. */
  const available: { id: string; colors: readonly ManaType[] }[] = [];
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined || inst.tapped) continue;
    const ch = characteristicsOf(state, inst);
    // Asked of the **live** characteristics rather than the printed type line, so an animated
    // artifact convokes and a creature turned into an artifact improvises.
    if (!(rule === 'convoke' ? ch.isCreature : hasType(ch.typeLine, 'artifact'))) continue;
    // Improvise pays generic and only generic, so an artifact's colours are not offered to the
    // assignment below. That is what stops a blue artifact paying a {U} pip.
    available.push({ id, colors: rule === 'convoke' ? ch.colors as readonly ManaType[] : [] });
  }
  // Mana-makers last, battlefield order within each group (the sort is stable). See the docblock:
  // a permanent spent on a pip is a permanent not spent on mana, and mana pays pips too.
  const makesMana = new Set(sources.map((source) => source.key));
  available.sort((a, b) => Number(makesMana.has(a.id)) - Number(makesMana.has(b.id)));

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
    // A permanent tapped for a cost cannot also be tapped for mana, so it leaves the source list.
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
export function bouncePlan(
  state: GameState, seat: SeatIndex, cost: NonNullable<AbilityCost['returnToHand']>, source: string,
): readonly string[] | null {
  /*
    "Return a land you control to its owner's hand" (D615): tapped first — a land tapped for mana
    and then returned is the whole trick of the card — then the cheapest, never the source. `null`
    when there are too few.
  */
  const fits = listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
    if (id === source) return false;
    const inst = state.instances[id];
    if (inst === undefined || isFaceDownPermanent(inst)) return false;
    const ch = characteristicsOf(state, inst);
    const kind = cost.kind === 'creature' ? ch.isCreature : hasType(ch.typeLine, cost.kind);
    return kind && (cost.subtype === undefined || cost.subtype === '' || hasSubtype(ch.typeLine, cost.subtype.toLowerCase()))
      // A basic one (D1329), by its supertype.
      && (cost.basic !== true || ch.typeLine.supertypes.some((t) => /^basic$/i.test(t)));
  });
  if (fits.length < cost.count) return null;
  const rank = (id: string): number => (state.instances[id]!.tapped ? 0 : 1000)
    + (state.cardDefs[state.instances[id]!.defKey]?.cmc ?? 0);
  return [...fits].sort((a, b) => rank(a) - rank(b)).slice(0, cost.count);
}

export function graveyardCostPlan(
  state: GameState, seat: SeatIndex, cost: NonNullable<AbilityCost['exileFromGraveyard']>, source: string,
): readonly string[] | null {
  /*
    "Exile a creature card from your graveyard" (D613): `graveyardFodder`'s order over the cards
    the cost names, and never the source — an ability activated from the graveyard is paying with
    other cards, and one activated from the battlefield has no card of its own there. `null` when
    there are too few.
  */
  const spare: string[] = [];
  const useful: string[] = [];
  for (const id of listAt(state, zoneKey(seat, 'graveyard'))) {
    if (id === source) continue;
    const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
    if (!cost.matches(def?.typeLine ?? '')) continue;
    const script = scriptForCard(def);
    if (script?.flashback !== undefined || escapeOf(state, id) !== undefined) useful.push(id);
    else spare.push(id);
  }
  // Collect evidence N (D1158): see `evidencePlan`.
  if (cost.totalManaValue !== undefined) return evidencePlan(state, seat, cost.totalManaValue, source, (id) => useful.includes(id));
  const plan = [...spare, ...useful].slice(0, cost.count);
  return plan.length < cost.count ? null : plan;
}

export function graveyardFodder(
  state: GameState, seat: SeatIndex, exclude: string | undefined, want: number,
): readonly string[] {
  if (want <= 0) return [];
  const spare: string[] = [];
  const useful: string[] = [];
  for (const id of listAt(state, zoneKey(seat, 'graveyard'))) {
    if (id === exclude) continue;
    const script = scriptForCard(state.cardDefs[state.instances[id]?.defKey ?? '']);
    if (script?.flashback !== undefined || escapeOf(state, id) !== undefined) useful.push(id);
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
 * refusal to offer rather than an offer to refuse — the same shape `tapToPayPlan` returns and for
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
 * What a declaration of attacks costs its player (D780, CR 508.1h): for every creature attacking a
 * player (not a planeswalker), the `attackTax` of each permanent that player controls. Generic mana.
 */
/**
 * An ability's mana cost as it is paid now (D781): the printed cost, less `costLess` for each thing
 * it counts, off the generic part only. Undefined when the ability costs no mana.
 */
export function abilityManaText(
  state: GameState, seat: SeatIndex, ability: AbilityDef, source: string,
): string | undefined {
  const printed = ability.cost.mana;
  if (printed === undefined || ability.costLess === undefined) return printed;
  const by = ability.costLess.per * Math.max(0, ability.costLess.count(state, source, seat));
  return by <= 0 ? printed : reducedCostText(printed, by) ?? printed;
}

export function attackTaxFor(
  state: GameState, attacks: readonly { readonly defender: SeatIndex; readonly planeswalker?: string }[],
): number {
  const perDefender = new Map<string, number>();
  const taxOf = (seat: SeatIndex, walker: boolean): number => {
    const key = `${seat}:${walker}`;
    const known = perDefender.get(key);
    if (known !== undefined) return known;
    let sum = 0;
    const theirs = listAt(state, zoneKey(seat, 'battlefield'));
    for (const id of theirs) {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst) || allAbilitiesLost(state, inst)) continue;
      const script = scriptForCard(state.cardDefs[inst.defKey]);
      const tax = script?.attackTax;
      if (tax === undefined || (walker && script?.attackTaxWalkers !== true)) continue;
      // Sphere of Safety (D802): one for each enchantment its controller has, as it is now.
      sum += tax === 'enchantments'
        ? theirs.filter((other) => {
          const there = state.instances[other];
          return there !== undefined && hasType(characteristicsOf(state, there).typeLine, 'enchantment');
        }).length
        : tax;
    }
    perDefender.set(key, sum);
    return sum;
  };
  return attacks.reduce((total, a) => total + taxOf(a.defender, a.planeswalker !== undefined), 0);
}

/** The permanents on the battlefield with a `tapManaExtra` (D1088), found once per state. */
const TAP_WATCHERS = new WeakMap<GameState, readonly CardInstance[]>();

function tapWatchers(state: GameState): readonly CardInstance[] {
  const known = TAP_WATCHERS.get(state);
  if (known !== undefined) return known;
  const out: CardInstance[] = [];
  for (let seat = 0; seat < state.seats.length; seat++) {
    for (const id of listAt(state, zoneKey(seat as SeatIndex, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) continue;
      if (scriptForCard(state.cardDefs[inst.defKey])?.tapManaExtra === undefined) continue;
      out.push(inst);
    }
  }
  TAP_WATCHERS.set(state, out);
  return out;
}

/**
 * The extra mana tapping `tapped` for mana adds (D1088, CR 605.1b): each Wild Growth on it, each
 * Crypt Ghast of its controller's when it is a Swamp. Empty when nothing watches it. A watcher whose
 * abilities are gone adds nothing, and one that chose no colour adds nothing for "the chosen color".
 */
export function tapManaExtras(state: GameState, tapped: string): readonly ManaType[] {
  const watchers = tapWatchers(state);
  if (watchers.length === 0) return [];
  const target = state.instances[tapped];
  if (target === undefined || target.zone !== 'battlefield') return [];
  const out: ManaType[] = [];
  let ch: ReturnType<typeof characteristicsOf> | undefined;
  for (const watcher of watchers) {
    const extra = scriptForCard(state.cardDefs[watcher.defKey])!.tapManaExtra!;
    if (extra.adds === 'produced' || !watcherSees(state, watcher, extra.watches, target, () => (ch ??= characteristicsOf(state, target)))) continue;
    if (allAbilitiesLost(state, watcher)) continue;
    if (extra.adds === 'chosen') {
      const colour = watcher.chosen?.color;
      if (colour !== undefined) out.push(colour as ManaType);
    } else {
      out.push(...extra.adds);
    }
  }
  return out;
}

/** Whether a watcher's `watches` takes in this tapped permanent (D1088, D1106). */
function watcherSees(
  state: GameState, watcher: CardInstance, watches: NonNullable<CardScript['tapManaExtra']>['watches'],
  target: CardInstance, ch: () => ReturnType<typeof characteristicsOf>,
): boolean {
  if (watches === 'enchanted') return watcher.attachedTo === target.id;
  if ('anyone' in watches) {
    const c = ch();
    if (!c.isLand) return false;
    const kind = watches.anyone;
    return kind === 'land' ? true
      : kind === 'basic land' ? c.typeLine.supertypes.some((s) => s.toLowerCase() === 'basic')
        : c.typeLine.subtypes.some((s) => kind.subtypes.some((t) => t.toLowerCase() === s.toLowerCase()));
  }
  if (watcher.zoneSeat !== target.zoneSeat) return false;
  const c = ch();
  const kind = watches.yours;
  return kind === 'land' ? c.isLand
    // Kinnan (D1257): "a nonland permanent".
    : kind === 'nonland permanent' ? !c.isLand
    : kind === 'creature' ? c.isCreature
      : kind === 'land creature' ? c.isLand && c.isCreature
        : c.typeLine.subtypes.some((s) => s.toLowerCase() === kind.subtype.toLowerCase());
}

/**
 * How many more mana of the type the tap made (D1106, CR 106.12): "Whenever a player taps a land
 * for mana, that player adds one mana of any type that land produced", once per Mana Flare. One
 * mana each, whatever the land made: Ancient Tomb's {C}{C} gets one {C} more, a dual one of the
 * colour it was tapped for.
 */
export function tapManaEchoes(state: GameState, tapped: string): number {
  const watchers = tapWatchers(state);
  if (watchers.length === 0) return 0;
  const target = state.instances[tapped];
  if (target === undefined || target.zone !== 'battlefield') return 0;
  let ch: ReturnType<typeof characteristicsOf> | undefined;
  let n = 0;
  for (const watcher of watchers) {
    const extra = scriptForCard(state.cardDefs[watcher.defKey])!.tapManaExtra!;
    if (extra.adds !== 'produced' || !watcherSees(state, watcher, extra.watches, target, () => (ch ??= characteristicsOf(state, target)))) continue;
    if (allAbilitiesLost(state, watcher)) continue;
    n++;
  }
  return n;
}

/** Which half of a split card is its aftermath half (D1296), or null. */
export function aftermathHalf(def: CardDef | undefined): number | null {
  if (def?.faces?.kind !== 'split') return null;
  const at = def.faces.cards.findIndex((face) => scriptForCard(face)?.aftermath === true);
  return at < 0 ? null : at;
}

/**
 * Whether a restricted mana ability is one the auto-payer never uses (D1397): a mana cost, or a cost
 * other than tapping, sacrificing itself, life or energy. Such an ability is a button, and its mana
 * floats marked (`GameState.boundMana`).
 */
function pressedForMana(ability: AbilityDef): boolean {
  const FREE = new Set(['tap', 'sacrificeSelf', 'life', 'energy']);
  return ability.cost.mana !== undefined || Object.keys(ability.cost).some((key) => !FREE.has(key)
    && (ability.cost as Record<string, unknown>)[key] !== undefined && (ability.cost as Record<string, unknown>)[key] !== false);
}

export function manaSources(
  state: GameState, seat: SeatIndex,
  /**
   * What is being paid for (D595). A restricted mana ability ("Spend this mana only to cast a
   * creature spell") is a source only for a payment its restriction allows, and **never** when
   * this is absent — every caller that does not say what it is paying for gets the unrestricted
   * sources, which can under-offer but never over-offer.
   */
  paying?: PaymentFor,
): ManaSourceEntry[] {
  const free: ManaSourceEntry[] = [];
  /*
    Restricted mana already in the pool (D1397), one source a mana, for a payment its words allow
    and for nothing else. First, so it is spent before anything is tapped.
  */
  if (paying !== undefined) {
    (state.boundMana?.[String(seat)] ?? []).forEach((unit, i) => {
      const rule = spendRestriction(unit.words);
      if (rule !== null && rule.chosenType !== true && rule.allows(paying)) {
        free.push({ key: `${BOUND_MANA_KEY}${i}`, produces: [unit.type], abilityIndex: -1 });
      }
    });
  }
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
    // Elves is a 1/1 with no text (CR 613.1f). See `allAbilitiesLost`. Nor an Arrested one (D943).
    /*
      Except a land whose land types an effect set (D1246, CR 305.7): it has lost its rules-text
      abilities, and keeps the one its new basic land type gives it. A Blood Mooned Command Tower
      taps for {R} and nothing else.
    */
    const retyped = landTypesSet(state, inst);
    /*
      And one whose abilities were taken away by an effect that then handed it one (D1290, Imprisoned
      in the Moon): that one only, and no basic land type's mana either.
    */
    const stripped = allAbilitiesLost(state, inst) && !retyped;
    if ((stripped && grantedAbilitiesOn(state, inst).length === 0) || characteristicsOf(state, inst).cantActivate) continue;
    const script = retyped || stripped ? undefined : scriptForCard(state.cardDefs[inst.defKey]);
    const ch = characteristicsOf(state, inst);
    /*
      The permanent's own mana abilities, and the ones an effect handed it (CR 113.6): a
      Karametra's Favor on a creature makes that creature a mana source, and a list that left it
      out would be an auto-tapper refusing a spell the player can pay for. Assembled exactly as the
      activation loop below does, for the same reason — one filter, not two that drift.
    */
    const abilities: readonly {
      readonly ability: AbilityDef; readonly index: number; readonly grantedBy?: GrantedTriggerRef;
    }[] = [
      ...(script?.abilities ?? []).map((ability, index) => ({ ability, index })),
      ...grantedAbilitiesOn(state, inst).flatMap((ref) => {
        const ability = grantedAbilityFor(state, ref);
        return ability === undefined ? [] : [{ ability, index: ref.index, grantedBy: ref }];
      }),
      /*
        And the mana a basic land type gives a land that has the type only because an effect says so
        (D699, CR 305.7): a Forest under Urborg taps for {B}, and every land under Dryad of the
        Ilysian Grove for any colour. The printed ones are in the script already; these are the
        types the land has now that its script does not make. Index -1: the solver's pick adds the
        mana itself, and nothing activates a source by index.
      */
      ...(ch.isLand && !stripped ? typeGrantedMana(ch.typeLine.subtypes)
        .filter((granted) => !(script?.abilities ?? []).some((own) => own.cost.tap && own.cost.mana === undefined
          && (own.produces ?? []).length === 1 && own.produces![0] === granted.produces![0]))
        .map((ability) => ({ ability, index: -1 })) : []),
    ];
    let usable: {
      index: number; produces: readonly ManaType[]; life: number; energy: number; sacrifices: boolean;
      grantedBy?: GrantedTriggerRef; restricted?: true; taps: boolean;
    }[] = [];
    for (const { ability, index: i, grantedBy } of abilities) {
      if (ability.produces === undefined || ability.produces.length === 0) continue;
      // "Activate only if …", and the commander's identity (D617), hold for a mana source too.
      if (ability.activateOnlyIf !== undefined && !ability.activateOnlyIf(state, id, seat)) continue;
      if (ability.spendOnly !== undefined && (paying === undefined || !ability.spendOnly.allows(paying))) continue;
      // "…of the chosen type" (D644): the type this source chose, on what is being paid for.
      if (ability.spendOnly?.chosenType === true) {
        const type = inst.chosen?.type;
        const line = paying?.spell ?? paying?.abilityOf;
        if (type === undefined || line === undefined || !hasSubtype(line, type)) continue;
      }
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
      /*
        And never one that costs a **card** (D580): Overeager Apprentice's "Discard a card,
        Sacrifice Overeager Apprentice: Add {B}{B}{B}" passes the line above on its sacrifice, and
        the auto-tapper would then spend it without a card ever leaving the hand — or with one it
        chose itself, which is worse. Which card to give up is the player's answer, so the ability
        is theirs to press: it stays in `legalActions` as a play and is not a source here.

        The costs D581 reads — a counter taken off, the card exiled, a typed sacrifice — are not
        named here, and that is measured rather than overlooked. Compiled over the legal corpus,
        58 mana abilities carry a sacrifice of something else, a counter removal, an exile of the
        card or a discard; exactly **one** of them also taps or sacrifices its own permanent with
        no mana in the cost, which is what the line above lets through, and it is the Apprentice.
        The other 57 never reach this line. Workhorse's "Remove a +1/+1 counter from Workhorse:
        Add {C}" is pressed by the player, like the Familiar's.
      */
      if (ability.cost.discardACard === true) continue;
      // Nor a sacrifice of another permanent (D666): Phyrexian Tower's creature is the player's pick.
      if (ability.cost.sacrifice !== undefined) continue;
      /*
        Nor one that taps **other** permanents (D645): Holdout Settlement's "{T}, Tap an untapped
        creature you control: Add one mana of any color." Which creature to tap is the player's
        answer — the auto-tapper would otherwise tap an attacker to pay for a spell — so the ability
        is a play the player presses, as the Apprentice's is above.
      */
      if (ability.cost.tapUntapped !== undefined) continue;
      // Nor one whose X of counters is the player's to announce (D1307): a storage land.
      if (ability.cost.removeXCounters !== undefined) continue;
      // Nor one that discards the hand (D1331): Lion's Eye Diamond is the player's to press.
      if (ability.cost.discardHand === true) continue;
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
      // A counted ability (D662) offers what it would make now, and nothing when that is zero.
      const made = producedBy(state, ability, id, seat);
      if (made.length === 0) continue;
      usable.push({
        index: i,
        produces: made,
        life: cost,
        energy: energyCost,
        sacrifices: ability.cost.sacrificeSelf === true,
        taps: ability.cost.tap === true,
        // Which card defines it, so `index` is never an ambiguous number: a granted ability's
        // index is a position in the grantor's table. See `ManaSourceEntry.grantedBy`.
        ...(grantedBy === undefined ? {} : { grantedBy }),
        ...(ability.spendOnly === undefined ? {} : { restricted: true as const }),
      });
    }
    /*
      A permanent with a restricted row and a free one is still one tap (D595). When the restricted
      row makes **more** — Eldrazi Temple's {C}{C} for an Eldrazi beside its {C} — it is the only
      row, because the solver sizes a choice at one mana and would throw the second {C} away. When
      every row makes one mana they are simply more choices, which is what a land that taps for {C}
      or for a colour its restriction allows is. Otherwise the free rows win.
    */
    const most = (rows: typeof usable): number => Math.max(0, ...rows.map((u) => u.produces.length));
    const open = usable.filter((u) => u.restricted !== true);
    const bound = usable.filter((u) => u.restricted === true);
    if (bound.length > 0 && most(bound) > most(open)) {
      // Every restricted row of that size: Ancient Ziggurat's five colours are still five choices.
      usable = bound.filter((u) => u.produces.length === most(bound));
    } else if (bound.length > 0 && !(most(bound) === 1 && most(open) <= 1)) {
      usable = open;
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
    /*
      And a run that covers a smaller row (D1306): a Forest under Gift of Paradise has its own {G}
      and five runs of two of one colour. The solver sizes a choice at one mana, so with the {G} in
      the choice the land would pay one where it can pay two. When the longest rows are runs of one
      colour and every shorter row's colours are among them, only the longest are the source: two of
      a colour is never worse than one of it. The player still sees every row offered.
    */
    const longest = most(usable);
    if (longest > 1 && usable.some((u) => u.produces.length < longest)) {
      const top = usable.filter((u) => u.produces.length === longest && new Set(u.produces).size === 1);
      const colours = new Set(top.map((u) => u.produces[0]));
      if (top.length > 0 && usable.every((u) => u.produces.length === longest ? top.includes(u) : u.produces.every((m) => colours.has(m)))) {
        usable = top;
      }
    }
    if (usable.length === 0) continue;
    const cost = usable[0]!.life;
    const eats = usable[0]!.sacrifices;
    const bucket = eats ? spent : cost > 0 ? painful : free;
    // A snow permanent's mana may pay `{S}` (D769).
    const snowy = characteristicsOf(state, inst).typeLine.supertypes.some((t) => t.toLowerCase() === 'snow')
      ? { snow: true as const } : {};
    // What a Wild Growth on it adds to every tap (D1088): part of the sum, or beside the choice.
    const extra = usable.every((u) => u.taps) ? tapManaExtras(state, id) : [];
    // And a Mana Flare's (D1106): one more of what the tap made.
    const echo = usable.every((u) => u.taps) ? tapManaEchoes(state, id) : 0;
    // One source per permanent, because tapping it is what pays — and several tap abilities on
    // one permanent are a *choice* between them, not a sum. That is what a dual land is: two
    // abilities, one tap, one mana. Treating them as a sum would offer spells nobody can cast.
    if (usable.length === 1) {
      bucket.push({
        key: id, produces: [...usable[0]!.produces, ...Array.from({ length: usable[0]!.produces.length > 0 ? echo : 0 }, () => usable[0]!.produces[0]!), ...extra], abilityIndex: usable[0]!.index,
        ...(usable[0]!.grantedBy === undefined ? {} : { grantedBy: usable[0]!.grantedBy }),
        ...(usable[0]!.restricted === true ? { restricted: true as const } : {}),
        ...(cost > 0 ? { life: cost } : {}),
        ...(eats ? { sacrifices: true } : {}),
        ...snowy,
      });
      continue;
    }
    /*
      Rows that are each a run of one colour, all the same length (D697): "Add three mana of any one
      color" is five rows of three. A choice of colour, then the whole run — not one mana.
    */
    const run = usable[0]!.produces.length;
    const runs = run > 1 && usable.every((u) => u.produces.length === run && new Set(u.produces).size === 1);
    bucket.push({
      key: id,
      produces: runs ? [...new Set(usable.map((u) => u.produces[0]!))] : usable.flatMap((u) => u.produces),
      ...(runs ? { chooseRun: run } : {}),
      ...(runs && usable.every((u) => u.restricted === true) ? { restricted: true as const } : {}),
      abilityIndex: usable[0]!.index,
      ...(usable[0]!.grantedBy === undefined ? {} : { grantedBy: usable[0]!.grantedBy }),
      choose: true,
      ...(extra.length > 0 ? { extra } : {}),
      ...(echo > 0 ? { echo } : {}),
      ...(cost > 0 ? { life: cost } : {}),
      ...(eats ? { sacrifices: true } : {}),
      ...snowy,
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
    let tapsForMana = false;
    // The kinds its taps make, for a Mana Flare's one more (D1106): optimistic, as the rest is.
    const tapKinds = new Set<ManaType>();
    const tapMost = new Map<ManaType, number>();
    // Nothing to reach for on a permanent with no abilities left. Kept in step with `manaSources`,
    // which is the point of both: one answer to "what can this seat pay". And Arrest's (D943).
    // And a land whose land types were set keeps only its new type's mana (D1246), as in `manaSources`.
    const retyped = landTypesSet(state, inst);
    /*
      And one whose abilities were taken away by an effect that then handed it one (D1290, Imprisoned
      in the Moon): that one only, and no basic land type's mana either.
    */
    const stripped = allAbilitiesLost(state, inst) && !retyped;
    if ((stripped && grantedAbilitiesOn(state, inst).length === 0) || characteristicsOf(state, inst).cantActivate) continue;
    const script = retyped || stripped ? undefined : scriptForCard(state.cardDefs[inst.defKey]);
    const ch = characteristicsOf(state, inst);
    // The granted ones too, kept in step with `manaSources` above — the dimmed pips and the
    // auto-tapper answering different questions about the same board is what both docblocks warn
    // against.
    for (const ability of [
      ...(script?.abilities ?? []),
      ...grantedAbilitiesOn(state, inst)
        .map((ref) => grantedAbilityFor(state, ref))
        .filter((ability): ability is AbilityDef => ability !== undefined),
      /*
        And the mana a basic land type gives a land only because an effect says so (D1246), which
        `manaSources` has counted since D699 and this had not: a Forest under Urborg lit no black pip.
      */
      ...(ch.isLand && !stripped ? typeGrantedMana(ch.typeLine.subtypes)
        .filter((granted) => !(script?.abilities ?? []).some((own) => own.cost.tap && own.cost.mana === undefined
          && (own.produces ?? []).length === 1 && own.produces![0] === granted.produces![0])) : []),
    ]) {
      if (ability.produces === undefined) continue;
      /*
        "Activate only if …" too, as `manaSources` asks it (D642). Without it a land that makes "one
        mana of the chosen color" — five abilities, one per colour, four of them off — lit every
        colour's pip here, and so did a Command Tower outside its commander's identity.
      */
      if (ability.activateOnlyIf !== undefined && !ability.activateOnlyIf(state, id, seat)) continue;
      // Pressed by the player, so not counted here either (D645): see `manaSources`.
      if (ability.cost.tapUntapped !== undefined) continue;
      // And for the same reason a sacrifice of another permanent (D666): Phyrexian Tower.
      if (ability.cost.sacrifice !== undefined) continue;
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
      if (!canPayLife(state, seat, life)) continue;
      /*
        A tap ability's mana is the most of each kind any one of them makes (D1306), since one tap
        pays for one: a Forest under Gift of Paradise is two green, not its own one plus the gift's
        two. Optimistic across kinds, as before, and summed for an ability that does not tap.
      */
      const made = new Map<ManaType, number>();
      // A storage land at its most (D1307): every counter it holds.
      const held = ability.cost.removeXCounters === undefined ? 0 : inst.counters[ability.cost.removeXCounters] ?? 0;
      for (const type of producedBy(state, ability, id, seat, held)) made.set(type as ManaType, (made.get(type as ManaType) ?? 0) + 1);
      for (const [type, n] of made) {
        if (!ability.cost.tap) { pool = addMana(pool, type, n); continue; }
        tapKinds.add(type);
        tapMost.set(type, Math.max(tapMost.get(type) ?? 0, n));
      }
      if (ability.cost.tap) tapsForMana = true;
    }
    for (const [type, n] of tapMost) pool = addMana(pool, type, n);
    // A Wild Growth's mana, once for the one tap (D1088).
    if (tapsForMana) for (const type of tapManaExtras(state, id)) pool = addMana(pool, type, 1);
    // A Mana Flare's (D1106).
    const echoes = tapsForMana ? tapManaEchoes(state, id) : 0;
    for (let i = 0; i < echoes; i++) for (const type of tapKinds) pool = addMana(pool, type, 1);
  }
  return pool;
}

const specsFor = (script: CardScript | undefined): readonly TargetSpec[] =>
  script?.targets ?? (script?.aura ? [script.aura.target] : []);

function playableTargets(
  state: GameState, specs: readonly TargetSpec[], seat: SeatIndex, source?: string,
): { ok: boolean; candidates: Target[][] } {
  const candidates = specs.map((spec) => legalTargets(state, spec, seat, source));
  /*
    An optional spec is optional down to its minimum (D1115): "one or two target creatures" with no
    creature to target is not castable, and offering it had the bot cast Wind Sail at nothing, which
    the cast then refused (sweep 61301, seed 61396).
  */
  const ok = specs.every((spec, i) => (candidates[i]?.length ?? 0) >= (spec.optional ? spec.min ?? 0 : 1));
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
    return scriptForCard(state.cardDefs[object.cardKey])?.splitSecond === true;
  });
}

/**
 * Whether this seat controls a restricted mana source at all (D595), so the cast and ability loops
 * only rebuild the source list per payment when there is something a payment could add to it.
 */
function hasRestrictedMana(state: GameState, seat: SeatIndex): boolean {
  return listAt(state, zoneKey(seat, 'battlefield')).some((id) => {
    const inst = state.instances[id];
    return inst !== undefined && (scriptForCard(state.cardDefs[inst.defKey])?.abilities ?? [])
      .some((ability) => ability.spendOnly !== undefined && ability.produces !== undefined);
  });
}

function castablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): Castable {
  const restrictedMana = hasRestrictedMana(state, seat);
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
  const landsAllowed = landDropsFor(state, seat);
  // Per commander (D640): see `commanderTaxFor`, asked for each card below.

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
  const topSpells = spellsFromTopFor(state, seat);
  const zones = [
    ...listAt(state, zoneKey(seat, 'hand'))
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: false, fromAdventure: false, impulse: false, offered: false })),
    ...listAt(state, zoneKey(seat, 'command'))
      // An emblem is in the command zone too, and is never cast (D734).
      .filter((id) => state.instances[id]?.emblem !== true)
      .map((id) => ({ id, fromCommand: true, flashback: false, escape: false, foretold: false, fromAdventure: false, impulse: false, offered: false })),
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => flashbackCostOf(state, id) !== undefined)
      .map((id) => ({ id, fromCommand: false, flashback: true, escape: false, foretold: false, fromAdventure: false, impulse: false, offered: false })),
    /*
      And the second narrow list over the graveyard: a card with escape (CR 702.139).

      Its own list rather than a widening of the flashback one, the way the two exile lists below
      are two lists: the cost is different, the cards are different, and the two differ in what
      happens at the *end* — a flashback spell is exiled as it leaves the stack and an escaped one
      goes back to the graveyard it came from. One card could in principle have both and would be
      offered twice, which is what the rules say happens.
    */
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => escapeOf(state, id) !== undefined)
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: true, foretold: false,
        fromAdventure: false, impulse: false, offered: false,
      })),
    /*
      And a card a permanent of this seat lets it cast out of the graveyard (D1287): "During each of
      your turns, you may cast a creature spell from your graveyard". Its own turn only, one spell a
      turn through each permanent, the first permanent whose kind fits. See `yardPermission`.
    */
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .map((id) => ({ id, by: yardPermission(state, seat, id) }))
      .filter((entry) => entry.by !== null)
      .map(({ id, by }) => ({
        id, fromCommand: false, flashback: false, escape: false, foretold: false,
        fromAdventure: false, impulse: false, offered: false, yardBy: by!,
      })),
    // And a split card's aftermath half (D1296), for its own cost.
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => aftermathHalf(state.cardDefs[state.instances[id]?.defKey ?? '']) !== null)
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: false, foretold: false,
        fromAdventure: false, impulse: false, offered: false, aftermath: true as const,
      })),
    // And the third: retrace (D599), the printed cost and a land card from hand.
    ...listAt(state, zoneKey(seat, 'graveyard'))
      .filter((id) => scriptForCard(state.cardDefs[state.instances[id]?.defKey ?? ''])?.retrace === true)
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: false, foretold: false,
        fromAdventure: false, impulse: false, offered: false, retrace: true,
      })),
    ...listAt(state, zoneKey(seat, 'exile'))
      .filter((id) => {
        const inst = state.instances[id];
        if (inst?.foretoldTurn === undefined || inst.foretoldTurn === state.turn) return false;
        return scriptForCard(state.cardDefs[inst.defKey])?.foretell !== undefined;
      })
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: true, fromAdventure: false, impulse: false, offered: false })),
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
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: false, fromAdventure: true, impulse: false, offered: false })),
    /*
      And a card this seat has been told it may play out of exile until a deadline (D583) —
      "Exile the top card of your library. You may play that card this turn."

      A third narrow list over the zone, told apart by its own field for the reason the other two
      are. Unlike them it is a **play**: the loop below offers a land in this list as the turn's
      land drop, at the same timing and against the same count as a land in hand. A spell is cast
      for what is printed on it and at its ordinary timing, which is why nothing below treats this
      entry as a different cost — only as a different place.
    */
    // Every exile zone (D1236): a card taken from another player's library sits in its owner's.
    ...state.seats.flatMap((other) => listAt(state, zoneKey(other.index, 'exile')))
      .filter((id) => state.instances[id]?.playFromExile?.by === seat)
      // A plotted card is cast on a later turn than the one it was plotted on (D922).
      .filter((id) => (state.instances[id]?.playFromExile?.through !== 'plotted'
        && state.instances[id]?.playFromExile?.through !== 'warped')
        || state.turn > state.instances[id]!.playFromExile!.grantedTurn)
      .map((id) => ({ id, fromCommand: false, flashback: false, escape: false, foretold: false, fromAdventure: false, impulse: true, offered: false })),
    /*
      And the sixth: the one card somebody has been told they may cast for nothing (CR 702.85a).

      A list of at most one, read off `pendingOfferedCast` rather than off the zone, because what makes
      this card castable is not where it is — it is sitting in exile beside everything else that has
      ever been exiled — but the offer the engine is holding the table open for. Which is also why
      it is not filtered by anything: the offer was made to this seat about this card, and the only
      question left below is what the spell needs chosen before it goes on the stack.
    */
    /*
      And lands in the graveyard while something lets this seat play them (D648) — Crucible of
      Worlds. A land drop and nothing else: `landOnly` keeps a spell in the same graveyard from
      being offered as a cast it has no permission for.
    */
    ...(landsFromGraveyardFor(state, seat) ? listAt(state, zoneKey(seat, 'graveyard')) : [])
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: false, foretold: false,
        fromAdventure: false, impulse: false, offered: false, landOnly: true,
      })),
    // And the top card of the library, when Courser of Kruphix says its lands may be played (D649).
    // And its spells, when Future Sight or Bolas's Citadel says so (D731): one entry for both.
    ...(landsFromTopFor(state, seat) || topSpells.length > 0 ? listAt(state, zoneKey(seat, 'library')).slice(0, 1) : [])
      .map((id) => ({
        id, fromCommand: false, flashback: false, escape: false, foretold: false,
        fromAdventure: false, impulse: false, offered: false, landOnly: topSpells.length === 0, fromTop: true,
      })),
    ...(state.pendingOfferedCast !== null && state.pendingOfferedCast.seat === seat
      ? [{
          id: state.pendingOfferedCast.card, fromCommand: false, flashback: false, escape: false,
          foretold: false, fromAdventure: false, impulse: false, offered: true,
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
    // A prepare card's spell is never cast from the hand (D978): only a copy, while it is prepared.
    if (faces.kind === 'prepare') return [{ ...entry, half: undefined as number | undefined }];
    // Nor is a flip card's flipped half, or a transforming card's back (D982): only the card is cast.
    if (faces.kind === 'flip') return [{ ...entry, half: undefined as number | undefined }];
    /*
      And a fuse card's two halves together (D1295, CR 702.102a): only from the hand, and only as a
      plain cast from it. The whole card is the fused spell, with the whole's cost and types.
    */
    // Aftermath (D1296): from the graveyard that half alone, and from anywhere else never that half.
    const after = faces.kind === 'split' ? aftermathHalf(state.cardDefs[state.instances[entry.id]?.defKey ?? '']) : null;
    if ('aftermath' in entry && entry.aftermath === true) {
      return after === null ? [] : [{ ...entry, half: after as number | undefined }];
    }
    if (after !== null) {
      return halves.filter((h) => h.half !== after);
    }
    const fusable = faces.kind === 'split' && state.instances[entry.id]?.zone === 'hand' && !entry.offered
      && scriptForCard(state.cardDefs[state.instances[entry.id]?.defKey ?? ''])?.fused === true;
    return faces.kind === 'split'
      ? [...halves, ...(fusable ? [{ ...entry, half: undefined as number | undefined, fuse: true as const }] : [])]
      : [{ ...entry, half: undefined as number | undefined }, ...halves];
  });

  for (const entry of castable) {
    const { id, fromCommand, flashback, escape, foretold, fromAdventure: adventure, impulse, offered, half } = entry;
    const tax = fromCommand ? commanderTaxFor(state, id) : 0;
    const yardBy = 'yardBy' in entry && typeof entry.yardBy === 'string' ? entry.yardBy : undefined;
    const fuse = 'fuse' in entry && entry.fuse === true;
    const aftermath = 'aftermath' in entry && entry.aftermath === true;
    // A permission's cast is retrace's shape for every question below but the land card (D1287).
    const retrace = ('retrace' in entry && entry.retrace === true) || yardBy !== undefined;
    const landOnly = 'landOnly' in entry && entry.landOnly === true;
    const inst = state.instances[id];
    if (inst === undefined) continue;
    /*
      One word below for both ways a card is cast out of exile at its printed cost: back from an
      adventure, or under a permission to play it (D583). They differ in which faces are offered —
      settled above, where `castable` is built — and in the label; in every other question this
      loop asks (no morph, no foretell, no suspend, no alternative cost) they are the same card in
      the same place, and those are plays the engine makes out of a hand.
    */
    const fromAdventure = adventure || impulse;
    if (splitSecond) {
      // Only the hand is worth explaining: a card in a graveyard or in exile is not drawn with a
      // reason beside it, for the same reason none of those zones goes through `why` at all.
      if (!fromCommand && !flashback && !escape && !retrace && !foretold && !fromAdventure && !offered) {
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
    const script = scriptForCard(def);
    // A graveyard entry under Crucible of Worlds is a land drop or nothing (D648).
    if (landOnly && !ch.isLand) continue;
    /*
      The top of the library (D731): a land only under a land permission, a spell only under a
      spell permission whose kind it is. Which costs that leaves is settled with the alternatives.
    */
    const fromTop = 'fromTop' in entry && entry.fromTop === true;
    if (fromTop && ch.isLand && !landsFromTopFor(state, seat)) continue;
    const topPermissions = fromTop && !ch.isLand && def !== undefined
      ? topSpells.filter((permission) => permission.applies(def))
      : [];
    if (fromTop && !ch.isLand && topPermissions.length === 0) continue;
    const topPrinted = !fromTop || topPermissions.some((permission) => permission.payLife !== true);
    const topLife = topPermissions.some((permission) => permission.payLife === true);

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
    if (script?.morph !== undefined && !flashback && !escape && !retrace && !fromCommand && !fromAdventure
      && !fromTop && sorcerySpeed) {
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
      /*
        Nor out of the graveyard by a permission to **cast** (D1334): a land is never cast (CR 305.9).
        Lurrus's "cast one permanent spell with mana value 2 or less" fits a Mountain, mana value 0,
        and the land drop it was offered as was refused by \`playLand\`, which threw a sweep's game
        (seed 96041). A graveyard land drop comes through its own entry, \`landOnly\` (Crucible of
        Worlds, Muldrotha's land).
      */
      if (flashback || escape || retrace || aftermath) continue;
      // "You may cast that card" (D1236) is never a land drop.
      if (impulse && inst.playFromExile?.castOnly === true) continue;
      if (sorcerySpeed && landsPlayed < landsAllowed) {
        /*
          Whether it will arrive tapped, said on the row (D587): a check land with no Mountain or
          Plains out is a different play from one with, and the player should not have to find out
          after. A shock land is offered twice, once paying its life and once not.
        */
        const landScript = scriptForCard(half === undefined
          ? state.cardDefs[inst.defKey]
          : state.cardDefs[inst.defKey]?.faces?.cards[half]);
        const unless = landScript?.entersUntappedIf;
        const tappedNote = unless !== undefined && !unless.test(state, seat, id)
          ? ` (enters tapped: ${unless.words})`
          : '';
        const shock = landScript?.payLifeToEnterUntapped;
        const base = {
          kind: 'land' as const, card: id, name: ch.name,
          manaCost: '', targetSpecs: [], candidates: [], isManaAbility: false, sacrificeOptions: [],
          ...(half === undefined ? {} : { half }),
        };
        // Named as the back of the card when that is what it is, because the player is looking at
        // a Hagra Mauling in their hand and "Play Hagra Broodpit" would otherwise read as a bug.
        const named = half === undefined
          ? `Play ${ch.name}${impulse
            ? ` from exile (${PLAY_FROM_EXILE_UNTIL[inst.playFromExile?.through ?? 'this-turn']})`
            : fromTop ? ' from the top of your library' : landOnly ? ' from your graveyard' : ''}`
          : `Play ${ch.name} (the back of ${state.cardDefs[inst.defKey]?.name ?? 'this card'})`;
        /*
          A land that chooses a colour as it enters (D642) is offered once per colour, which is
          where a land's choice can be made: nothing resolves for it, so there is no question to
          ask after it is played.
        */
        // And a creature type (D644), one row per type this table offers — Unclaimed Territory.
        const colourChoice = landScript?.entersChoice === 'color' || landScript?.entersChoice === 'creature-type'
          ? landScript.decisions?.flatMap((d) => (typeof d === 'function' ? [] : [d])).find(isChoiceDecision)
          : undefined;
        if (colourChoice !== undefined) {
          for (const word of colourChoice.optionsFor?.(state, seat) ?? colourChoice.options) {
            out.push({ ...base, description: `${named}, choosing ${word}${tappedNote}`, choose: word });
          }
        } else if (shock !== undefined) {
          if ((state.seats[seat]?.life ?? 0) > shock) {
            out.push({ ...base, description: `${named} untapped (pay ${shock} life)`, payLife: true });
          }
          out.push({ ...base, description: `${named} tapped` });
        } else {
          out.push({ ...base, description: `${named}${tappedNote}` });
        }
      } else if (!sorcerySpeed) {
        why(id, 'a land is played in your own main phase, with nothing on the stack');
      } else {
        why(id, landsPlayed > 1
          ? `you have already played ${landsPlayed} lands this turn`
          : 'you have already played a land this turn');
      }
      continue;
    }

    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant') || ch.keywords.has('flash')
      // "As though it had flash" (D727).
      || scriptForCard(state.cardDefs[inst.defKey])?.castAsThoughFlash !== undefined
      // And a permanent that grants it (D800): Leyline of Anticipation.
      || flashGranted(state, seat, ch);
    // An offered cast ignores the timing, because the ability offering it is what says when: cascade
    // casts its hit mid-resolution, with a spell on the stack underneath. See `castSpell`.
    if (!instantSpeed && !sorcerySpeed && !offered) {
      why(id, 'sorcery speed: your own main phase, with nothing on the stack');
      continue;
    }
    // A permanent's casting limit (D788): Rule of Law, Teferi, Grand Abolisher.
    const prohibited = castProhibition(state, seat, ch.isCreature, offered, inst.zone === 'hand', hasType(ch.typeLine, 'artifact'),
      state.cardDefs[inst.defKey]?.name, inst.zone);
    if (prohibited !== null) {
      why(id, prohibited);
      continue;
    }
    // A plotted card is cast "as a sorcery", an instant included (D922).
    const plottedCast = impulse && inst.playFromExile?.through === 'plotted';
    if (plottedCast && !sorcerySpeed) {
      why(id, 'a plotted card is cast as a sorcery: your own main phase, with nothing on the stack');
      continue;
    }

    /*
      Foretell: the special action that hides the card, offered beside its ordinary cast.

      A second play on the same card like the morph above, and offered on the same terms — the
      printed cost is not looked at, because {2} to exile it is a move you make *instead of*
      casting it and often because you cannot cast it. During your own turn only (CR 702.143a),
      which in this engine is the window a sorcery gets.
    */
    if (script?.foretell !== undefined && !flashback && !escape && !retrace && !fromCommand && !foretold
      && !fromAdventure && !fromTop && sorcerySpeed) {
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
    if (script?.suspend !== undefined && !flashback && !escape && !retrace && !fromCommand && !foretold
      && !fromAdventure && !fromTop && sorcerySpeed) {
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

    // And plot (D922), suspend's sibling: the card's own cost, from hand, as a sorcery.
    if (script?.plot !== undefined && inst.zone === 'hand' && !flashback && !escape && !retrace && !fromCommand
      && !foretold && !fromAdventure && sorcerySpeed) {
      const cost = parseManaCost(script.plot.cost);
      if (cost.unsupported === undefined && canAfford(poolOf(state, seat), cost, sources)) {
        out.push({
          kind: 'plot', card: id, name: ch.name,
          description: `Plot ${ch.name} (${script.plot.cost}; cast it free on a later turn)`,
          manaCost: script.plot.cost, targetSpecs: [], candidates: [],
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
    const printedAlternatives = flashback || escape || retrace || foretold || fromCommand || fromAdventure || offered
      // Every one of these is paid from the hand (D731): the top of the library has only its own.
      || fromTop
      ? []
      : [
        /*
          What each keyword costs besides the mana, said out loud on the play.

          A player reading "Cast Mulldrifter for {2}{U}" and then watching it die would have been
          misled by the table rather than by the card, and the same is true of a 3/1 that attacks
          and then disappears. Two keywords, one shape, and the difference between them is this
          sentence — so it lives here with the cost rather than in two copies of the code below.
        */
        // A pitched evoke (D1377) is offered only while there is a card of its colour to exile.
        ...(script?.evoke === undefined
          || (script.evoke.pitch !== undefined && pitchOptions(state, seat, id, script.evoke.pitch).length === 0) ? [] : [{
          flag: 'evoked' as const,
          cost: script.evoke.cost,
          note: script.evoke.pitch === undefined
            ? `evoke cost (${script.evoke.cost}, sacrificed as it arrives)`
            : `evoke cost (exile a ${COLOUR_NAMES[script.evoke.pitch]} card from your hand, sacrificed as it arrives)`,
          specs: specsFor(script),
        }]),
        ...(script?.dash === undefined ? [] : [{
          flag: 'dashed' as const,
          cost: script.dash.cost,
          note: script.dash.warp === true
            ? `warp cost (${script.dash.cost}, exiled at end of turn; cast it from exile on a later turn)`
            : script.dash.blitz === true
            ? `blitz cost (${script.dash.cost}, hasty, draws a card when it dies, sacrificed at end of turn)`
            : `dash cost (${script.dash.cost}, hasty, back to your hand at end of turn)`,
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
          // Surge (D928), prowl and freerunning (D935) are the same play under other conditions.
          || spectacleRefusal(state, seat, state.cardDefs[state.instances[id]?.defKey ?? ''], script.spectacle) !== null
          ? []
          : [{
              flag: 'spectacled' as const,
              cost: script.spectacle.cost,
              note: script.spectacle.surge === true
                ? `surge cost (${script.spectacle.cost}, because you have cast another spell this turn)`
                : script.spectacle.prowl === true
                  ? `prowl cost (${script.spectacle.cost}, because a creature sharing its type dealt combat damage to a player)`
                  : script.spectacle.freerunning === true
                    ? `freerunning cost (${script.spectacle.cost}, because an Assassin or commander dealt combat damage to a player)`
                    : `spectacle cost (${script.spectacle.cost}, because an opponent has lost life this turn)`,
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
        /*
          And "if you control a commander, you may cast this spell without paying its mana cost"
          (D653): an alternative cost of nothing, offered while one of the caster's commanders —
          or anybody's commander the caster controls — is on the battlefield.
        */
        ...(script?.freeWithCommander !== true || !controlsACommander(state, seat) ? [] : [{
          flag: 'commanderFree' as const,
          cost: '{0}',
          note: 'commander bonus (free, because you control a commander)',
          specs: specsFor(script),
        }]),
        /*
          And the pitch (D691): "exile a blue card from your hand rather than pay this spell's mana
          cost". Offered while another card of that colour is in hand, the printed life can be paid
          without ending the game, and, for the Forces that say so, it is not the caster's turn.
        */
        ...(script?.pitch === undefined || pitchOptions(state, seat, id, script.pitch.colour).length === 0
          || (script.pitch.notYourTurn === true && state.activeSeat === seat)
          || !canPayLife(state, seat, script.pitch.life ?? 0)
          ? [] : [{
            flag: 'pitchCast' as const,
            cost: '{0}',
            note: `alternative cost (exile a ${COLOUR_NAMES[script.pitch.colour]} card from your hand${script.pitch.life === undefined ? '' : ` and pay ${script.pitch.life} life`})`,
            specs: specsFor(script),
          }]),
        /*
          A printed alternative of mana or life (D1251): the Bringers, Snuff Out. Offered while the
          caster controls the land type it names, and has the life to pay without losing.
        */
        ...(script?.altCost === undefined || !altCostOpen(state, seat, script.altCost) ? [] : [{
          flag: 'altCast' as const,
          cost: script.altCost.mana ?? '{0}',
          note: `alternative cost (${script.altCost.lands?.basic === true
            // The Borderposts (D1329): the mana and the land.
            ? `${script.altCost.mana === undefined ? '' : `${script.altCost.mana} and `}return a basic land you control`
            : script.altCost.lands !== undefined
            ? `${script.altCost.lands.how} ${script.altCost.lands.count === 1 ? `a ${script.altCost.lands.subtype}` : `${script.altCost.lands.count} ${script.altCost.lands.subtype}s`}`
            : script.altCost.life === undefined ? script.altCost.mana ?? '{0}' : `${script.altCost.life} life`})`,
          specs: specsFor(script),
        }]),
        // Impending (D1097): cheaper, and not a creature until its time counters are gone.
        ...(script?.impending === undefined ? [] : [{
          flag: 'impended' as const,
          cost: script.impending.cost,
          note: `impending cost (${script.impending.cost}, enters with ${script.impending.n} time counters and is not a creature until the last is removed)`,
          specs: specsFor(script),
        }]),
        // Prototype (D934): the smaller, cheaper card.
        ...(script?.prototype === undefined ? [] : [{
          flag: 'prototyped' as const,
          cost: script.prototype.cost,
          note: `prototype cost (${script.prototype.cost}, as a ${script.prototype.power}/${script.prototype.toughness})`,
          specs: specsFor(script),
        }]),
        // Awaken (D932): the spell's own targets, then the land to awaken.
        ...(script?.awaken === undefined ? [] : [{
          flag: 'awakened' as const,
          cost: script.awaken.cost,
          note: `awaken cost (${script.awaken.cost}, and a land you control becomes a 0/0 Elemental with ${script.awaken.n} +1/+1 counter${script.awaken.n === 1 ? '' : 's'} and haste)`,
          specs: [...specsFor(script), AWAKEN_LAND] as readonly TargetSpec[],
        }]),
        ...(script?.overload === undefined ? [] : [{
          flag: 'overloaded' as const,
          cost: script.overload.cost,
          note: `overload cost (${script.overload.cost}, each instead of one)`,
          specs: [] as readonly TargetSpec[],
        }]),
      ];
    /*
      Bolas's Citadel's cost (D731): life equal to the spell's mana value instead of its mana cost,
      offered while the life is there to pay without ending the game (the line D585 draws).
    */
    const topLifeCost = def?.cmc ?? 0;
    const alternatives = [
      ...printedAlternatives,
      ...(!topLife || !canPayLife(state, seat, topLifeCost) ? [] : [{
        flag: 'payLifeFromTop' as const,
        cost: '{0}',
        note: `cost from the top of your library (${topLifeCost} life)`,
        specs: specsFor(script),
      }]),
    ];
    for (const alternative of alternatives) {
      const altChange = costChangeFor(state, seat, def, id);
      const altCost = withCostChange(parseManaCost(alternative.cost), altChange);
      if (altCost.unsupported !== undefined || !canAfford(poolOf(state, seat), altCost, sources)) continue;
      /*
        A modal spell is offered once per combination of modes here too (D1394), as its printed cast
        is below. Sweep seed 105085 threw "choose a mode for Thunderbolt": Bolas's Citadel offered
        the top card's cast with no mode, and the engine refused the play it had offered.
      */
      const modeRows: readonly (readonly number[] | null)[] = modeCombinations(script, state, seat);
      for (const modes of modeRows.length === 0 ? [null] : modeRows) {
      const chosenModes = modes === null ? null : modesOf(script, modes);
      const altSpecs = chosenModes === null ? alternative.specs
        : [...modeTargetSpecs(chosenModes), ...(alternative.flag === 'awakened' ? [AWAKEN_LAND] : [])] as readonly TargetSpec[];
      const altTargets = playableTargets(state, altSpecs, seat, id);
      if (!altTargets.ok) continue;
      out.push({
        kind: 'cast', card: id, name: ch.name, [alternative.flag]: true,
        description: `Cast ${ch.name} for its ${alternative.note}`
          + (chosenModes === null ? '' : ` — ${chosenModes.map((m) => m.description).join('; and ')}`),
        manaCost: alternative.cost,
        ...(altChange.generic === 0
          ? {}
          : { costChange: altChange.generic, costNote: altChange.notes[0] ?? '' }),
        ...(modes === null ? {} : { modes: [...modes] }),
        targetSpecs: altSpecs, candidates: altTargets.candidates,
        isManaAbility: false, sacrificeOptions: [],
        ...(alternative.flag === 'pitchCast' && script?.pitch !== undefined
          ? {
            discardOptions: pitchOptions(state, seat, id, script.pitch.colour),
            pitchWords: `${COLOUR_NAMES[script.pitch.colour]} card`,
          }
          : {}),
        ...(alternative.flag === 'evoked' && script?.evoke?.pitch !== undefined
          ? {
            discardOptions: pitchOptions(state, seat, id, script.evoke.pitch),
            pitchWords: `${COLOUR_NAMES[script.evoke.pitch]} card`,
          }
          : {}),
      });
      }
    }

    // A top card the only permission for is Bolas's Citadel's has no printed cast (D731).
    if (!topPrinted) continue;

    // Emerge (D929): an alternative cost paid partly with a creature, one play with its creatures.
    if (script?.emerge !== undefined && !flashback && !escape && !retrace
      && !foretold && !fromCommand && !fromAdventure && !offered && !fromTop) {
      const emergeChange = costChangeFor(state, seat, def, id);
      const emergeTargets = playableTargets(state, specsFor(script), seat, id);
      const fodder = emergeTargets.ok
        ? emergeOptions(state, seat, id, script.emerge.cost, (text) => canAfford(poolOf(state, seat), withCostChange(parseManaCost(text), emergeChange), sources))
        : [];
      if (fodder.length > 0) {
        out.push({
          kind: 'cast', card: id, name: ch.name, emerged: true,
          description: `Cast ${ch.name} for its emerge cost (${script.emerge.cost}, less the mana value of the creature you sacrifice)`,
          manaCost: script.emerge.cost,
          targetSpecs: specsFor(script), candidates: emergeTargets.candidates,
          isManaAbility: false, sacrificeOptions: fodder,
        });
      }
    }

    // Flashback and foretell both replace the cost, so everything from here on — affordability, X,
    // the description — is about that cost rather than the printed one.
    /*
      And an offered cast replaces it with whatever the offer says, which is the shortest arm of
      the chain and the only one where the printed cost is not looked at at all: cascade pays
      nothing and madness pays a cost of its own, and both are on the offer rather than on the card.
    */
    const costShown = offered ? state.pendingOfferedCast?.cost ?? ''
      // A plotted card is cast without paying its mana cost (D922), and so is Mind's Desire's (D1344).
      : plottedCast || (impulse && inst.playFromExile?.free === true) ? ''
      : flashback ? flashbackCostOf(state, id) ?? ''
        // Escape replaces the printed cost like flashback and foretell, which is why it is in the
        // same chain: the mana half of "Escape—{2}{R}{R}, Exile three other cards" is the whole of
        // what this spell costs in mana, and the card half is counted separately below.
        : escape ? escapeOf(state, id)?.cost ?? ''
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
    const sacrificeAsked = script?.additionalCost !== undefined && 'sacrifice' in script.additionalCost
      ? script.additionalCost
      : undefined;
    let victims = sacrificeAsked === undefined
      ? []
      : sacrificeOptions(state, seat, id, sacrificeAsked);
    if (sacrificeAsked !== undefined && victims.length === 0) {
      const fodder = sacrificeWords(sacrificeAsked);
      why(id, sacrificeAsked.sacrifice === 'another-creature'
        ? 'it asks for another creature to sacrifice, and you have none'
        : `it asks for ${/^[aeiou]/.test(fodder) ? 'an' : 'a'} ${fodder} to sacrifice, and you have none`);
      continue;
    }
    /*
      The two additional costs that are not a sacrifice (D585), by the same rule: a cost that
      cannot be paid is a spell that is not offered. "Discard a card" needs another card in the
      hand — the spell itself does not count — and its candidates travel on the play as
      `discardOptions`, the way an ability's do. A printed life payment needs more life than it
      costs, which is the line every life cost here draws.
    */
    const discardAsked = (script?.additionalCost !== undefined && 'discard' in script.additionalCost)
      // Jump-start's (D908): only when this play is the graveyard casting.
      || (flashback === true && script?.flashback?.discard === true);
    // Retrace's discard is a land card (D599); with a printed discard as well it would be two, which
    // nothing prints and nothing here can ask.
    if (retrace && yardBy === undefined && discardAsked) continue;
    const pitches = retrace && yardBy === undefined
      ? listAt(state, zoneKey(seat, 'hand')).filter((card) =>
        hasType(parseTypeLine(state.cardDefs[state.instances[card]?.defKey ?? '']?.typeLine), 'land'))
      : discardAsked ? discardOptions(state, seat, id) : [];
    if (retrace && yardBy === undefined && pitches.length === 0) continue;
    if (discardAsked && pitches.length === 0) {
      why(id, 'it asks you to discard a card, and you have no other card in hand');
      continue;
    }
    // And which half of the board a sacrifice eats, where it is not simply creatures — the same
    // field an ability's cost sets, for the same two readers. See `LegalPlay.sacrificeKind`.
    const eats = {
      ...(sacrificeAsked?.sacrifice === 'artifact' || sacrificeAsked?.sacrifice === 'artifact-or-creature'
        ? { sacrificeKind: sacrificeAsked.sacrifice } : {}),
      ...(sacrificeAsked === undefined || sacrificeAsked === null ? {} : { sacrificeWords: sacrificeWords(sacrificeAsked) }),
    };
    const pitchOn = {
      ...(pitches.length === 0 ? {} : { discardOptions: pitches }), ...eats,
      ...(retrace && yardBy === undefined ? { retrace: true as const } : {}),
      ...(yardBy === undefined ? {} : { yardBy }),
    };
    const lifeAsked = script?.additionalCost !== undefined && 'life' in script.additionalCost
      ? script.additionalCost.life
      : 0;
    if (!canPayLife(state, seat, lifeAsked)) {
      why(id, `it costs ${lifeAsked} life, and you do not have that to pay`);
      continue;
    }
    // Cards exiled from your graveyard as an additional cost (D967): too few, and it is not offered.
    const graveAsked = script?.additionalCost !== undefined && 'exileFromGraveyard' in script.additionalCost
      ? script.additionalCost.exileFromGraveyard
      : undefined;
    if (graveAsked !== undefined && graveyardCostPlan(state, seat, graveAsked, id) === null) {
      why(id, `it costs ${graveAsked.count} ${graveAsked.words === '' ? '' : `${graveAsked.words} `}card${graveAsked.count === 1 ? '' : 's'} from your graveyard, and you have too few`);
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
    const escaping = escape ? escapeOf(state, id) : undefined;
    const escapeFodder = escaping !== undefined
      ? graveyardFodder(state, seat, id, escaping.exile)
      : [];
    if (escaping !== undefined && escapeFodder.length < escaping.exile) {
      why(id, `escape asks for ${escaping.exile} other cards in your graveyard`);
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
    /*
      Everything the spell could be aimed at, for a change that depends on its target (D611): the
      offer is the cheaper one when any candidate earns it, and the candidates are narrowed below
      to the ones that do when only the cheaper cast is affordable.
    */
    const aimable = script?.selfCostChange?.targets === undefined
      ? undefined
      : playableTargets(state, specsFor(script), seat, id).candidates.flat();
    const change = costChangeFor(state, seat, def, id, aimable);
    const cost: ManaCost = withCostChange(taxed, change);
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
    const tapRule: TapToPayRule | null = script?.convoke === true ? 'convoke'
      : script?.improvise === true ? 'improvise' : null;
    const convoked = tapRule === null ? null : tapToPayPlan(state, seat, payable, sources, tapRule);
    if (tapRule !== null && convoked === null) {
      why(id, tapRule === 'convoke'
        ? 'not enough mana, counting every land you could tap and every creature you could convoke'
        : 'not enough mana, counting every land you could tap and every artifact you could improvise with');
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
      && !canAfford(poolOf(state, seat), payable, restrictedMana
        // A restricted mana source counts for a spell its restriction allows (D595).
        ? manaSources(state, seat, payingFor(state, id, def))
        : sources, 0, phyrexianLife(state, seat))) {
      why(id, 'not enough mana, counting every land you could still tap');
      continue;
    }
    /*
      And fodder that is also mana — a Treasure — offered only where the mana is there without it
      (sweep 47815): `castSpell` pays with the sacrificed permanent kept out of the sources.
    */
    if (victims.length > 0 && convoked === null && (!offered || costShown !== '')) {
      const all = restrictedMana ? manaSources(state, seat, payingFor(state, id, def)) : sources;
      victims = victims.filter((victim) => canAfford(poolOf(state, seat), payable, all.filter((source) => source.key !== victim)));
      if (victims.length === 0) {
        why(id, 'everything it could sacrifice is needed for its mana');
        continue;
      }
    }
    /*
      The half of the cost that is paid in cards, said out loud on the play.

      Escape's count is printed on the card; delve's is whatever the plan worked out, and both are
      the same kind of thing to the player reading the offer — mana is not all this is going to
      cost. Which cards they are is left out on purpose: they are recomputed as the spell is cast,
      and an offer that named them would be promising something the payment is not bound to.
    */
    const exilesOn = escaping !== undefined
      ? { escape: true as const, exiles: escaping.exile }
      : delved !== null && delved.exiled.length > 0 ? { exiles: delved.exiled.length } : {};
    const taxOn = fromCommand && tax > 0 ? { commanderTax: tax } : {};
    // Only when it actually moved the number: a Thalia taxing a creature spell changes nothing,
    // and a note saying so would be noise on every card in the deck.
    const changeOn = {
      ...(cost.generic === taxed.generic ? {} : { costChange: cost.generic - taxed.generic }),
      // And a Leech's coloured surcharge (D1313).
      ...((change.coloured ?? []).length === 0 ? {} : { costExtra: change.coloured!.map((type) => `{${type}}`).join('') }),
      ...(cost.generic === taxed.generic && (change.coloured ?? []).length === 0 ? {} : { costNote: change.notes[0] ?? '' }),
    };
    /*
      X at zero is a legal cast of an X spell and sometimes the only one available, so a cost with
      {X} is offered whenever the rest of it can be paid; `xMax` says how high the player may go.

      `payable` is the cost **being paid**, which is the offer's own cost on an offered cast — so a
      cascade hit is offered with no X (its cost is empty, so `payable.x` is false) and a miracle'd
      `{X}{R}` is offered with one. That distinction is CR 107.3b, and until D460 the engine's other
      half disagreed with it: see the refusal in `autoActions`.
    */
    /*
      And an X paid in **life** rather than mana (D579): "As an additional cost to cast this spell,
      pay X life". The same field, because it is the same announcement — only the bound differs,
      and it is the caster's life by the rule every life cost here keeps (one less than the total;
      task #411 is whether the total itself should be payable). An additional cost is paid on a
      free cast too, and CR 107.3b's "X is 0" is about an {X} in the **mana** cost, which this
      card does not have — so an offered Deluge keeps its question.
    */
    const lifeX = script?.additionalCost !== undefined && 'lifeX' in script.additionalCost;
    const xLimit = payable.x
      ? maxAffordableX(poolOf(state, seat), payable, sources)
      : lifeX ? Math.max(0, (state.seats[seat]?.life ?? 1) - 1) : null;
    const xHint = xLimit === null || script?.bestX === undefined
      ? null
      : Math.max(0, Math.min(xLimit, Math.trunc(script.bestX(state, seat, xLimit))));
    const xOn = xLimit === null
      ? {}
      : { xMax: xLimit, ...(xHint === null ? {} : { xDefault: xHint }) };

    // A modal spell is offered once per legal combination of modes, and a combination whose
    // targets cannot be filled is not offered at all — so "destroy target creature; or draw two
    // cards" offers only the draw when the board is empty.
    const combinations = modeCombinations(script, state, seat);
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
          isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
        });
      }
      /*
        Entwined (D675): every mode, for the printed cost plus the entwine cost, offered as the
        kicker's second row is and only when the whole thing can be paid.
      */
      // And a kicker that picks the modes (D1095), offered the same way: one row, kicked.
      const entwine = (script?.modal?.entwine === true || script?.modal?.kickerModes !== undefined)
        && !flashback && !escape && !foretold ? script?.kicker : undefined;
      if (entwine !== undefined) {
        const all = modeCombinations(script, state, seat, true)[0]!;
        const chosen = modesOf(script, all);
        const specs = modeTargetSpecs(chosen);
        const { ok, candidates } = playableTargets(state, specs, seat, id);
        const withEntwine = parseManaCost(`${def?.manaCost ?? ''}${entwine.cost}`);
        const entwinedCost: ManaCost = withCostChange(
          fromCommand && tax > 0 ? { ...withEntwine, generic: withEntwine.generic + tax } : withEntwine,
          change,
        );
        if (ok && withEntwine.unsupported === undefined && canAfford(poolOf(state, seat), entwinedCost, sources)) {
          out.push({
            kind: 'cast', card: id, name: ch.name, kicked: true,
            description: `Cast ${ch.name} with ${entwine.description.toLowerCase()} — ${chosen.map((m) => m.description).join('; and ')}`,
            manaCost: `${def?.manaCost ?? ''}${entwine.cost}`, ...taxOn,
            modes: all, targetSpecs: specs, candidates,
            isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
          });
        }
      }
      continue;
    }

    const specs = specsFor(script);
    const { ok, candidates: open } = playableTargets(state, specs, seat, id);
    if (!ok) {
      why(id, 'nothing it could legally target');
      continue;
    }
    /*
      A cast that is affordable only because of what it targets (D611): "costs {3} less if it
      targets a tapped creature" off four lands is a cast at a tapped creature, so the candidates
      say so. The first spec that has one that earns it is narrowed to those, and the rest are left
      alone — Animist's Might's legendary creature is its first target, not its second. Delve,
      convoke and improvise are not asked again for the dearer cost; the narrowing is assumed.
    */
    const earns = script?.selfCostChange?.targets;
    let candidates = open;
    if (earns !== undefined && !offered && aimable !== undefined) {
      const full = costChangeFor(state, seat, def, id, []);
      const fullAffordable = full.generic === change.generic || (script?.delve !== true && tapRule === null
        && canAfford(poolOf(state, seat), withCostChange(taxed, full), restrictedMana
          ? manaSources(state, seat, payingFor(state, id, def))
          : sources));
      const at = fullAffordable ? -1 : open.findIndex((list) => list.some((t) => earns(state, seat, t, id)));
      if (at >= 0) candidates = open.map((list, i) => (i === at ? list.filter((t) => earns(state, seat, t, id)) : list));
    }

    /*
      And convoke said out loud on the play, because otherwise the table offers a seven-mana spell
      off four lands and gives no reason at all.

      The count rather than the names: which creatures get tapped is the engine's to decide (see
      `tapToPayPlan`), and a player reading "convoking 3" knows what the cast is about to cost them
      without having to work out which three.
    */
    const convokeNote = convoked !== null && convoked.tapped.length > 0
      ? ` (${tapRule === 'improvise' ? 'improvising' : 'convoking'} ${convoked.tapped.length})`
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
          ? `Cast ${ch.name} from your graveyard (escape ${costShown}, exiling ${escapeOf(state, id)?.exile ?? 0})`
          : yardBy !== undefined
            ? `Cast ${ch.name} from your graveyard for ${costShown} (${state.cardDefs[state.instances[yardBy]?.defKey ?? '']?.name ?? 'a permission'})`
          : retrace
            ? `Cast ${ch.name} from your graveyard (retrace ${costShown}, discarding a land card)`
          : foretold
            ? `Cast ${ch.name} from exile (foretold ${costShown})`
            : impulse
              // The deadline is the half the player has to act on, so the row says it.
              ? `Cast ${ch.name} from exile (${PLAY_FROM_EXILE_UNTIL[inst.playFromExile?.through ?? 'this-turn']})`
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
      description: fuse ? `Cast ${ch.name} fused, both halves, for ${costShown.replace(/ \/\/ /g, '')}`
        : aftermath ? `Cast ${ch.name} from your graveyard (aftermath ${costShown}, then exiled)` : castLabel,
      ...(fuse ? { fuse: true as const } : {}),
      ...(aftermath ? { aftermath: true as const } : {}),
      // The two halves' costs together, as one cost (CR 702.102c), rather than the card's "{R} // {G}".
      manaCost: fuse ? costShown.replace(/ \/\/ /g, '') : costShown, ...taxOn, ...changeOn, ...xOn, ...exilesOn,
      targetSpecs: specs, candidates,
      ...(script?.extraTargetCost === undefined ? {} : { extraTargetCost: script.extraTargetCost }),
      ...(script?.extraTargetColoured === undefined ? {} : { extraTargetColoured: script.extraTargetColoured }),
      ...(flashback ? { flashback: true } : {}),
      ...(foretold ? { foretold: true } : {}),
      ...(offered ? { offered: true } : {}),
      ...(half === undefined ? {} : { half }),
      isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
    });

    // Conspire (D926): the same cast again, with two creatures sharing a colour with it to tap.
    if (script?.conspire === true && !offered && conspireOptions(state, seat, id, ch.colors).length >= 2) {
      out.push({
        kind: 'cast', card: id, name: ch.name, conspire: true,
        description: `${castLabel} with conspire (tapping two creatures that share a color with it, and copy it)`,
        manaCost: costShown, ...taxOn, ...changeOn, ...xOn, ...exilesOn,
        targetSpecs: specs, candidates,
        ...(flashback ? { flashback: true } : {}),
        ...(foretold ? { foretold: true } : {}),
        ...(half === undefined ? {} : { half }),
        isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
      });
    }
    /*
      Casualty (D923): the same cast again, with a creature of power N or greater to sacrifice as it
      is cast, and a copy for it. Only beside a cast with no sacrifice of its own to make.
    */
    if (script?.casualty !== undefined && victims.length === 0 && !offered) {
      const fodder = casualtyOptions(state, seat, id, script.casualty);
      if (fodder.length > 0) {
        out.push({
          kind: 'cast', card: id, name: ch.name, casualty: true,
          description: `${castLabel} with casualty ${script.casualty} (sacrifice a creature with power ${script.casualty} or greater, and copy it)`,
          manaCost: costShown, ...taxOn, ...changeOn, ...xOn, ...exilesOn,
          targetSpecs: specs, candidates,
          ...(flashback ? { flashback: true } : {}),
          ...(foretold ? { foretold: true } : {}),
          ...(half === undefined ? {} : { half }),
          isManaAbility: false, sacrificeOptions: fodder, ...pitchOn,
        });
      }
    }

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
    // A double kicker (D1099) is three plays: either kicker, or both.
    const kickings: readonly { readonly with?: 'second' | 'both'; readonly count?: number; readonly cost: string; readonly words: string }[] = kicker === undefined ? []
      // Multikicker (D1100): once, twice, … as far as the mana goes (the loop stops at the first it cannot pay).
      : kicker.multi === true ? Array.from({ length: 8 }, (_, i) => ({ count: i + 1, cost: kicker.cost.repeat(i + 1), words: `multikicker x${i + 1}` }))
      : kicker.second === undefined ? [{ cost: kicker.cost, words: kicker.description.toLowerCase() }]
        : [
          { cost: kicker.cost, words: `kicker ${kicker.cost}` },
          { with: 'second', cost: kicker.second.cost, words: `kicker ${kicker.second.cost}` },
          { with: 'both', cost: `${kicker.cost}${kicker.second.cost}`, words: `both kickers (${kicker.cost} and ${kicker.second.cost})` },
        ];
    for (const kicking of kicker === undefined ? [] : kickings) {
      const withKicker = parseManaCost(`${def?.manaCost ?? ''}${kicking.cost}`);
      const kickedCost: ManaCost = withCostChange(
        fromCommand && tax > 0
          ? { ...withKicker, generic: withKicker.generic + tax }
          : withKicker,
        change,
      );
      // A multikicker paid more times than the mana covers is not offered, nor any count above it.
      if (kicking.count !== undefined && !(withKicker.unsupported === undefined && canAfford(poolOf(state, seat), kickedCost, sources))) break;
      /*
        A kicker paid in a sacrifice or in life (D1103): offered only when that can be paid too
        (CR 601.2h), with the permanents it may eat on the play the way an additional cost's are.
      */
      const extra = kicker!.additional;
      let kickVictims = victims;
      let kickEats = {};
      if (extra !== undefined) {
        if (script?.additionalCost !== undefined) continue;
        if ('life' in extra) {
          if (!canPayLife(state, seat, extra.life)) continue;
        } else if ('exileFromGraveyard' in extra) {
          // "You may collect evidence N" as the optional cost (D1159): offered only when it can be paid.
          if (graveyardCostPlan(state, seat, extra.exileFromGraveyard, id) === null) continue;
        } else {
          kickVictims = sacrificeOptions(state, seat, id, extra);
          if (kickVictims.length === 0) continue;
          kickEats = {
            ...(extra.sacrifice === 'artifact' || extra.sacrifice === 'artifact-or-creature' ? { sacrificeKind: extra.sacrifice } : {}),
            sacrificeWords: sacrificeWords(extra),
          };
        }
      }
      if (withKicker.unsupported === undefined && canAfford(poolOf(state, seat), kickedCost, sources)) {
        out.push({
          kind: 'cast', card: id, name: ch.name, kicked: true,
          ...(kicking.with === undefined ? {} : { kickedWith: kicking.with }),
          ...(kicking.count === undefined ? {} : { kickCount: kicking.count }),
          description: `Cast ${ch.name} with ${kicking.words}`,
          manaCost: `${def?.manaCost ?? ''}${kicking.cost}`, ...taxOn,
          ...(kickedCost.x ? { xMax: maxAffordableX(poolOf(state, seat), kickedCost, sources) } : {}),
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: kickVictims, ...pitchOn, ...kickEats,
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
        change,
      );
      if (withBuyback.unsupported === undefined
        && canAfford(poolOf(state, seat), boughtCost, sources)) {
        out.push({
          kind: 'cast', card: id, name: ch.name, buyback: true,
          description: `Cast ${ch.name} with ${buyback.description.toLowerCase()}`,
          manaCost: `${def?.manaCost ?? ''}${buyback.cost}`, ...taxOn,
          ...(boughtCost.x ? { xMax: maxAffordableX(poolOf(state, seat), boughtCost, sources) } : {}),
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
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
          change,
        );
        if (!canAfford(poolOf(state, seat), cost, sources)) break;
        out.push({
          kind: 'cast', card: id, name: ch.name, replicate: times,
          // Squad pays the same way (D924), and buys token copies rather than spell copies.
          description: script?.squad !== undefined
            ? `Cast ${ch.name} with squad x${times} (${times} token cop${times === 1 ? 'y' : 'ies'})`
            : `Cast ${ch.name} with replicate x${times}`,
          manaCost: text, ...taxOn,
          targetSpecs: specs, candidates, isManaAbility: false, sacrificeOptions: victims, ...pitchOn,
        });
      }
    }

  }
  /*
    And a copy of each prepared permanent's spell (D978). Asked of the state the cast itself makes
    — the copy in exile under a permission to cast it, the permanent unprepared — so the cost, the
    timing, the targets and the affordability are exactly the ones `castSpell` will check, and the
    recursion ends: the permanent asked about is no longer prepared in the state asked.
  */
  for (const permanent of listAt(state, zoneKey(seat, 'battlefield'))) {
    if (state.instances[permanent]?.prepared !== true) continue;
    const made = preparedCopyOf(state, permanent, seat);
    if (made === null) continue;
    for (const play of castablePlays(made.state, seat, sources).plays) {
      if (play.card !== made.id || play.kind !== 'cast') continue;
      out.push({
        ...play, card: permanent, half: 0, preparedCopy: true,
        description: `Cast a copy of ${play.description.replace(/^Cast /, '').replace(/ from exile \(this turn only\)/, '')} (prepared)`,
      });
    }
  }
  return { plays: out, blocked };
}

function activatablePlays(state: GameState, seat: SeatIndex, sources: ManaSources): LegalPlay[] {
  const restrictedMana = hasRestrictedMana(state, seat);
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
    // And the command zone, for a commander's commander ninjutsu (D1346).
    ...listAt(state, zoneKey(seat, 'command')).filter((id) => state.instances[id]?.isCommander === true)
      .map((id) => ({ id, zone: 'command' as const })),
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
    // Except what the same effect handed it afterwards (D1290): only those, then.
    const stripped = zone === 'battlefield' && allAbilitiesLost(state, inst);
    if (stripped && grantedAbilitiesOn(state, inst).length === 0) continue;
    // "Its activated abilities can't be activated" (D943).
    if (zone === 'battlefield' && characteristicsOf(state, inst).cantActivate) continue;
    const script = stripped ? undefined : scriptForCard(state.cardDefs[inst.defKey]);
    const ch = characteristicsOf(state, inst);
    /*
      The permanent's own abilities, and then the ones continuous effects have handed it (CR 113.6).

      One list and one loop, because every rule below applies identically to both: a granted `{T}`
      ability taps the **host**, a granted sorcery-speed one is still sorcery speed, and a granted
      one on a creature that arrived this turn is still summoning-sick. Offering granted abilities
      from a second loop would have been a second copy of those fifteen checks, which is how two
      paths that must agree stop agreeing.

      The index each carries means different things in the two cases, and that is what `grantedBy`
      is for: for a printed ability it is the position in this card's own `abilities`, and for a
      granted one the position in the *grantor's* `grantedAbilities`. See `CardScript.grantedAbilities`
      for why the granted one is not renumbered into a single assembled list.

      Granted abilities only on the battlefield, which is where a continuous effect reaches: this
      loop also walks the hand and the graveyard, and nothing grants an ability to a card there.
    */
    const offered: readonly {
      readonly ability: AbilityDef;
      readonly index: number;
      readonly grantedBy?: GrantedTriggerRef;
    }[] = [
      ...(script?.abilities ?? []).map((ability, index) => ({ ability, index })),
      ...(zone !== 'battlefield' ? [] : grantedAbilitiesOn(state, inst).flatMap((ref) => {
        const ability = grantedAbilityFor(state, ref);
        // A reference to a card this build does not script is skipped rather than offered as a
        // play with no ability behind it — the same answer the granted-trigger collector gives.
        return ability === undefined ? [] : [{ ability, index: ref.index, grantedBy: ref }];
      })),
    ];

    for (const { ability, index: i, grantedBy } of offered) {
      /*
        A restricted mana ability is not a button (D595): the mana could only float, and floating
        mana does not remember what it may pay for. The engine taps it while paying for something
        its restriction allows — see `AbilityDef.spendOnly`.
      */
      /*
        Unless the auto-payer cannot use it (D1397): one with a mana cost or a cost it does not pay
        (Castle Garenbrig's {2}{G}{G}, Food Chain's exiled creature) is pressed, and its mana floats
        in the pool still marked with what it may pay for (`GameState.boundMana`).
      */
      if (ability.produces !== undefined && ability.spendOnly !== undefined
        && (ability.spendOnly.chosenType === true || !pressedForMana(ability))) continue;
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
      if (wants !== zone && !(zone === 'command' && ability.cost.alsoFromCommandZone === true)) continue;
      /*
        Split second (CR 702.19): a mana ability still works, and nothing else does.

        The exception is written into the rule and it earns its place — a seat that tapped a land to
        hold up an answer can still tap the rest, and `produces` is exactly the flag that says an
        ability is a mana ability, the same one `isManaAbility` is built from below.
      */
      if (splitSecond && ability.produces === undefined) continue;
      // Faith's Fetters (D944): everything but a mana ability is switched off.
      if (zone === 'battlefield' && ability.produces === undefined && characteristicsOf(state, inst).cantActivateNonMana) continue;
      // Grand Abolisher (D788): an opponent's artifacts, creatures and enchantments, on its controller's turn.
      if (zone === 'battlefield' && abilityProhibition(state, seat, characteristicsOf(state, inst)) !== null) continue;
      if (ability.sorcerySpeed && !sorcerySpeed) continue;
      // "Activate only if …" — monstrosity's one-shot clause, and the reason the Lion's ability
      // disappears from the table once it has been paid for. See `AbilityDef.activateOnlyIf`.
      if (ability.activateOnlyIf !== undefined && !ability.activateOnlyIf(state, id, seat)) continue;
      // "Activate only once each turn" (CR 602.5f), the same rule one index deeper than the
      // loyalty check below. See `AbilityDef.onceEachTurn`.
      // And "no more than twice each turn" (D943), the same rule with a count.
      if (usesLeftThisTurn(state, inst, ability, abilityUseKey(i, grantedBy)) <= 0) continue;
      // "Activate only during your turn / upkeep / before attackers" (CR 602.5d). Its own
      // predicate rather than `sorcerySpeed`'s — see `atActivationTiming`.
      if (ability.timing !== undefined && !atActivationTiming(state, seat, ability.timing)) continue;
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
      // The untap symbol (D627): only while tapped, and the same summoning-sickness rule as {T}.
      if (ability.cost.untap === true) {
        if (!inst.tapped) continue;
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
      // What it costs now (D781): a channel land's "costs {1} less for each legendary creature".
      const manaNow = abilityManaText(state, seat, ability, id);
      if (manaNow
        && !canAfford(poolOf(state, seat), parseManaCost(manaNow), restrictedMana
          ? manaSources(state, seat, { abilityOf: ch.typeLine, abilityColors: ch.colors })
          : sources, 0, phyrexianLife(state, seat))) continue;
      // Life is a cost like any other: an ability you cannot pay for is not offered, which is why
      // a Mana Confluence stops making mana at one life and a City of Brass does not.
      const lifeCost = abilityLifeCost(state, seat, ability.cost);
      if (!canPayLife(state, seat, lifeCost)) continue;
      // An ability whose cost is a sacrifice is not activatable with nothing to sacrifice.
      const victims = sacrificeOptions(state, seat, id, ability.cost);
      if (ability.cost.sacrifice !== undefined && victims.length < (ability.cost.sacrificeCount ?? 1)) continue;
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
      // "Discard a card" (D579): not offered to a hand with nothing in it to discard.
      const kind = ability.cost.discardKind;
      const pitches = ability.cost.discardACard === true
        ? discardOptions(state, seat, id).filter((card) => kind === undefined
          || kind.matches(state.cardDefs[state.instances[card]?.defKey ?? '']?.typeLine ?? ''))
        : [];
      if (ability.cost.discardACard === true && pitches.length < (ability.cost.discardCount ?? 1)) continue;
      // "At random" (D614): offered to a hand with any other card in it; nobody picks.
      if (ability.cost.discardAtRandom === true && discardOptions(state, seat, id).length === 0) continue;

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
      // And "tap an untapped creature you control" (D610): not offered without enough to tap.
      const tapped = ability.cost.tapUntapped === undefined
        ? null
        : tapCostPlan(state, seat, ability.cost.tapUntapped, id, ability.cost.tap === true);
      if (ability.cost.tapUntapped !== undefined && tapped === null) continue;
      // And "return a land you control to its owner's hand" (D615): not offered without enough.
      if (ability.cost.returnToHand !== undefined
        && bouncePlan(state, seat, ability.cost.returnToHand, id) === null) continue;
      // And "exile a creature card from your graveyard" (D613): not offered without enough.
      if (ability.cost.exileFromGraveyard !== undefined
        && graveyardCostPlan(state, seat, ability.cost.exileFromGraveyard, id) === null) continue;
      /*
        A permanent the cost spends some other way cannot also make its mana (sweep 47815).

        Thraxodemon — "{3}, {T}, Sacrifice another creature or artifact" — was offered with a
        Treasure as its fodder, and the {3} was then paid by cracking that same Treasure, so the
        sacrifice found nothing to sacrifice. The same holds for the source tapped by {T}, the
        creatures crew or "tap an untapped creature" taps, and whatever is sacrificed: each is
        kept out of the mana here, and in `activate`, which pays with the same exclusions. Fodder
        whose loss would leave the mana short is not offered, and an ability with none left is not.
      */
      let fodder = victims;
      if (manaNow) {
        const cost = parseManaCost(manaNow);
        const all = restrictedMana ? manaSources(state, seat, { abilityOf: ch.typeLine, abilityColors: ch.colors }) : sources;
        const spent = new Set<string>([...(ability.cost.tap ? [id] : []), ...(crew ?? []), ...(tapped ?? [])]);
        const affords = (also?: string) => canAfford(poolOf(state, seat), cost,
          all.filter((source) => !spent.has(source.key) && source.key !== also), 0, phyrexianLife(state, seat));
        if (spent.size > 0 && !affords()) continue;
        if (ability.cost.sacrifice !== undefined) {
          fodder = victims.filter((victim) => affords(victim));
          if (fodder.length < (ability.cost.sacrificeCount ?? 1)) continue;
        }
      }

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
        manaCost: manaNow ?? '', abilityIndex: i,
        // How high its X may go (D789), with what the rest of the cost spends kept out of the mana.
        ...(manaNow && parseManaCost(manaNow).x ? {
          xMax: Math.min(maxAffordableX(poolOf(state, seat), parseManaCost(manaNow),
            (restrictedMana ? manaSources(state, seat, { abilityOf: ch.typeLine, abilityColors: ch.colors }) : sources)
              .filter((source) => !(ability.cost.tap === true && source.key === id) && !(crew ?? []).includes(source.key) && !(tapped ?? []).includes(source.key))),
          // And no more than the counters an X of them removes (D1307): Talon of Pain.
          ability.cost.removeXCounters === undefined ? Infinity : inst.counters[ability.cost.removeXCounters] ?? 0),
        } : ability.cost.removeXCounters !== undefined ? { xMax: inst.counters[ability.cost.removeXCounters] ?? 0 } : {}),
        // Which card defines it, when this permanent did not print it. See `LegalPlay.grantedBy`.
        ...(grantedBy === undefined ? {} : { grantedBy }),
        ...(zone === 'hand' ? { fromHand: true } : {}),
        ...(zone === 'graveyard' ? { fromGraveyard: true } : {}),
        targetSpecs: specs, candidates, isManaAbility: ability.produces !== undefined,
        sacrificeOptions: fodder,
        // Which kind of cost that list is for, read off the cost rather than guessed from the list.
        ...(ability.cost.sacrifice === 'artifact' ? { sacrificeKind: 'artifact' as const } : {}),
        ...(ability.cost.sacrifice === undefined ? {} : { sacrificeWords: sacrificeWords(ability.cost) }),
        // A counted sacrifice (D732): this many of `sacrificeOptions`, sent as `sacrifices`.
        ...((ability.cost.sacrificeCount ?? 1) > 1 ? { sacrificeCount: ability.cost.sacrificeCount } : {}),
        ...(ninjas.length === 0 ? {} : { returnOptions: ninjas }),
        ...(pitches.length === 0 ? {} : { discardOptions: pitches }),
        ...((ability.cost.discardCount ?? 1) > 1 ? { discardCount: ability.cost.discardCount } : {}),
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
    const morph = turnUpCostOf(state, inst);
    if (morph === null) continue;
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
    if (morph.cost.life !== undefined && !canPayLife(state, seat, morph.cost.life)) continue;
    // A card of the colour to reveal (D1328).
    const revealColour = morph.cost.revealColour;
    if (revealColour !== undefined && !listAt(state, zoneKey(seat, 'hand')).some((card) => state.instances[card] !== undefined
      && characteristicsOf(state, state.instances[card]!).colors.includes(revealColour))) continue;
    const word = morph.word;
    out.push({
      kind: 'turnUp', card: id, name: def?.name ?? 'that card',
      description: `Turn ${def?.name ?? 'it'} face up (${word} ${morphCostText(morph.cost)})`,
      manaCost: mana, targetSpecs: [], candidates: [],
      isManaAbility: false, sacrificeOptions: [],
    });
  }
  /*
    A Room's locked doors (D1298, CR 709.5e): each a special action as a sorcery, for that door's
    mana cost, offered when it can be paid.
  */
  if (sorcerySpeed) {
    for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
      const inst = state.instances[id];
      const def = inst === undefined ? undefined : state.cardDefs[inst.defKey];
      if (inst === undefined || def?.faces?.kind !== 'split') continue;
      def.faces.cards.forEach((door, index) => {
        if (!/\bRoom\b/.test(door.typeLine) || inst.doors?.[index] === true) return;
        const cost = parseManaCost(door.manaCost);
        if (cost.unsupported !== undefined || !canAfford(poolOf(state, seat), cost, sources)) return;
        out.push({
          kind: 'unlock', card: id, name: def.name, door: index,
          description: `Unlock ${door.name} (${door.manaCost})`,
          manaCost: door.manaCost, targetSpecs: [], candidates: [],
          isManaAbility: false, sacrificeOptions: [],
        });
      });
    }
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
  state: GameState, seat: SeatIndex, def: CardDef | undefined, card?: string,
  /**
   * What the spell is, or may be, aimed at (D611): the targets chosen, when it is being cast, or
   * every legal candidate, when it is being offered. A change that depends on the target applies
   * when one of these passes it, and never when this is absent.
   */
  aimedAt?: readonly Target[],
): CostChange {
  if (def === undefined) return { generic: 0, notes: [] };
  let up = 0;
  let down = 0;
  const notes: string[] = [];
  // Coloured mana added (D1313): the Leeches.
  const coloured: ManaType[] = [];
  for (const other of state.seats) {
    // And a commander in its command zone, for the modifiers eminence marks (D1262).
    const commanding = listAt(state, zoneKey(other.index, 'command'))
      .filter((id) => state.instances[id]?.emblem !== true);
    for (const id of [...listAt(state, zoneKey(other.index, 'battlefield')), ...commanding]) {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) continue;
      const script = scriptForCard(state.cardDefs[inst.defKey]);
      for (const mod of script?.costModifiers ?? []) {
        if (inst.zone === 'command' && mod.fromCommandZone !== true) continue;
        const mine = other.index === seat;
        if (mod.whose === 'controller' && !mine) continue;
        if (mod.whose === 'opponents' && mine) continue;
        if (!mod.applies(state, seat, def, id)) continue;
        // "For each …" (D1253): counted now, so the cost follows the board.
        const times = mod.per === undefined ? 1 : Math.max(0, mod.per(state, seat, id));
        if (times === 0) continue;
        if (mod.generic >= 0) up += mod.generic * times;
        else down -= mod.generic * times;
        for (let i = 0; i < times; i += 1) coloured.push(...(mod.coloured ?? []));
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
  const own = scriptForCard(def)?.affinity;
  if (own !== undefined) {
    // Artifacts, or whatever else the card prints (D597): the test is the keyword's own.
    const counts = own === 'artifacts'
      ? (id: string) => hasType(characteristicsOf(state, state.instances[id]!).typeLine, 'artifact')
      : (id: string) => own.counts(state, id);
    const n = listAt(state, zoneKey(seat, 'battlefield')).filter((id) => {
      const inst = state.instances[id];
      if (inst === undefined || isFaceDownPermanent(inst)) return false;
      return counts(id);
    }).length;
    if (n > 0) {
      down += n;
      notes.push(`affinity for ${own === 'artifacts' ? 'artifacts' : own.words}: {${n}} less`);
    }
  }
  // And a conditional change printed on the spell: "costs {1} less to cast if …" (D578).
  const conditional = scriptForCard(def)?.selfCostChange;
  if (conditional !== undefined && conditional.generic !== 0 && conditional.when(state, seat, card)
    && (conditional.targets === undefined
      || (aimedAt ?? []).some((target) => conditional.targets!(state, seat, target, card)))) {
    // Times the count when it is "for each …" (D601); a count of nought changes nothing.
    const amount = conditional.generic * (conditional.per === undefined ? 1 : conditional.per(state, seat, card));
    if (amount > 0) up += amount;
    else down -= amount;
    if (amount !== 0) notes.push(conditional.per === undefined ? conditional.description : `${conditional.description}: {${Math.abs(amount)}} ${amount < 0 ? 'less' : 'more'}`);
  }
  if (up === 0 && down === 0 && coloured.length === 0) return { generic: 0, notes: [] };
  return { generic: up - down, notes, ...(coloured.length === 0 ? {} : { coloured }) };
}

/**
 * What the table does to one spell's cost (CR 601.2f): generic up or down, and the coloured mana a
 * Leech adds (D1313). `withCostChange` applies both.
 */
export interface CostChange {
  readonly generic: number;
  readonly notes: readonly string[];
  readonly coloured?: readonly ManaType[];
}

/** Applies a cost change to a parsed cost, taking generic down to nought and no further. */
export function withCostChange(cost: ManaCost, change: number | CostChange): ManaCost {
  const by = typeof change === 'number' ? change : change.generic;
  const coloured = typeof change === 'number' ? [] : change.coloured ?? [];
  const generic = Math.max(0, cost.generic + by);
  let out = generic === cost.generic ? cost : { ...cost, generic };
  // And the coloured mana added (D1313), one symbol each.
  if (coloured.length > 0) {
    const colors = { ...out.colors };
    for (const type of coloured) colors[type] = (colors[type] ?? 0) + 1;
    out = { ...out, colors };
  }
  return out;
}

/** Everything `seat` may do in the current state. */
/**
 * The life a seat may pay toward Phyrexian symbols (D766): all but the last point, as every life
 * payment here (`canPayLife`), and none while its life total can't change.
 */
function phyrexianLife(state: GameState, seat: SeatIndex): number {
  return lifeLocked(state, seat) ? 0 : Math.max(0, (state.seats[seat]?.life ?? 0) - 1);
}

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
    // `scriptForCard`, so the offer sees a compiled card's trigger targets too (D485).
    const specs = object === undefined ? [] : abilityTargetSpecs(state, object, scriptForCard);
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
        ...(decision.looked === undefined ? {} : { looked: [...decision.looked] }),
        ...(decision.picksGoTo === undefined ? {} : { picksGoTo: decision.picksGoTo }),
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
        // In words rather than as the mana string, so a ward paid in life has a button that says so.
        cost: paymentWords(payment),
        ward: payment.source,
        spell: state.stackObjects[payment.counters]?.description ?? 'it',
        ...((payment.discard ?? 0) > 0 ? { discard: payment.discard } : {}),
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
  if (payment !== null) return mustPay === null ? empty : { ...empty, passLabel: `Pay ${paymentWords(payment)}` };
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

/**
 * What turning this face-down permanent face up costs (D1153), or `null` when it cannot be: its morph
 * or megamorph cost (CR 702.37b), or, for a card put onto the battlefield by manifest that is a
 * creature card, its mana cost (CR 701.40b). A manifested card that is not a creature card stays face
 * down unless it has morph.
 */
export function turnUpCostOf(
  state: GameState, inst: CardInstance,
): { readonly cost: { readonly mana?: string; readonly life?: number; readonly revealColour?: Color }; readonly mega?: true; readonly word: string } | null {
  const def = state.cardDefs[inst.defKey];
  const morph = scriptForCard(def)?.morph;
  if (morph !== undefined) {
    return { cost: morph.cost, ...(morph.mega === true ? { mega: true as const } : {}), word: morph.mega === true ? 'megamorph' : 'morph' };
  }
  if (inst.manifested === true && def !== undefined && hasType(parseTypeLine(def.typeLine), 'creature')) {
    return { cost: { mana: def.manaCost ?? '' }, word: 'manifested, its mana cost' };
  }
  return null;
}
