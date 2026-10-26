/**
 * The shape of a card script.
 *
 * The aim is that adding a card is a few declarative lines, because the engine has to grow one card
 * at a time and a scripting API that is tedious stops getting used. A script says what a card
 * *needs* (targets, costs) and what it *does* (an effect built from `effects.ts`); the engine owns
 * everything else — paying the cost, putting it on the stack, checking targets are still legal,
 * putting it in the graveyard afterwards, and noticing that something died.
 *
 * A card with no script still works. It can be cast if its mana cost parses, it resolves onto the
 * battlefield if it is a permanent, and its printed keywords are read from its oracle text — so an
 * unscripted Grizzly Bears attacks and blocks correctly. What it will not do is anything written in
 * prose, and the table says so rather than pretending: an unscripted spell resolves with no effect
 * and the log records that it was not automated, which is the honest version of "the computer did
 * something you did not expect".
 */
import type { Keyword } from './characteristics.js';
import type { EffectFn, PumpOptions } from './effects.js';
import type { ManaType } from './mana.js';
import type { GameState, SeatIndex } from './types.js';
import type { AttackedTarget, DecisionZone, Step, Target } from './turnTypes.js';

/** What a spell or ability needs pointed at it before it can be put on the stack. */
export interface TargetSpec {
  /**
   * What may be pointed at. The `graveyard-*` kinds point at a *card* in a graveyard rather than a
   * permanent on the battlefield — a different object in a different zone, which is why they are
   * their own kinds rather than a filter on `creature`. A card in a graveyard has no continuous
   * effects applied to it, so its **printed** type is what it is; `graveyard-card` takes any card
   * and leaves the rest to `filter`.
   *
   * `spell` and `ability` are both objects on the stack and are *not* interchangeable: a spell is a
   * card and an ability is not, so they arrive as different `Target` shapes and a card that takes
   * either says `spell-or-ability` rather than hoping. Those three are the printed difference
   * between a Cancel, a Stifle and a Disallow.
   */
  readonly kind:
    | 'creature' | 'permanent' | 'player' | 'any' | 'spell'
    | 'ability' | 'spell-or-ability'
    | 'graveyard-creature' | 'graveyard-land' | 'graveyard-card';
  /** Shown to the player choosing, e.g. "target creature an opponent controls". */
  readonly description: string;
  /** How many of this spec. Defaults to 1. */
  readonly count?: number;
  /** "up to": the spell is castable with fewer, including none. */
  readonly optional?: boolean;
  /**
   * Extra restriction beyond the kind, e.g. only creatures you control.
   *
   * `source` is the card the targeting belongs to, when there is one — the permanent whose
   * ability this is, or the spell being cast. That is what "another target creature" and "a
   * creature this is not already attached to" need, and without it a script would have to guess
   * which of the candidates was itself.
   */
  readonly filter?: (
    state: GameState, candidate: Target, controller: SeatIndex, source?: string,
  ) => boolean;
  /**
   * Advice to the bot: what this points at is being **helped**, not hit.
   *
   * Not a restriction, and deliberately not one. "Prevent the next 3 damage that would be dealt to
   * any target" may legally be aimed at an opponent's creature, and at a four-player table there
   * are reasons to; a filter that stopped it would be a different card. What it changes is which
   * legal target the bot *picks*, because its default is "the enemy and the enemy's creatures" —
   * sensible for the removal and the burn that are most of what targets anything, and exactly
   * backwards for a shield, which is simply thrown away on an opponent.
   *
   * Declared on the spec, like `preventsDamage` is declared on the card, the mode or the ability:
   * the engine does not read either, and both exist because the bot cannot work out intent from an
   * effect it has not run yet.
   *
   * The pump spells have the same problem and do **not** carry this yet: `chooseTargets` says so,
   * and fixing it there is a change to five cards' measured behaviour rather than a flag.
   */
  readonly friendly?: boolean;
  /**
   * A quantity split among the targets of this spec, announced as the spell is cast (CR 601.2d):
   * "Arc Lightning deals 3 damage divided as you choose among one, two, or three targets."
   *
   * The number is the whole amount, and the division is a fact about the *cast* rather than about
   * the resolution — both players can read it off the stack before deciding whether to respond,
   * the way they can read X and the chosen modes.
   *
   * **Two rules come free of the amount, and that is why there is no `min` field here.** Each
   * chosen target must be assigned at least one (CR 601.2d), and the whole amount must be
   * assigned — so `count: 3, divided: 3` *is* "one, two, or three targets": zero targets leaves
   * three unassigned, and a fourth target would have nothing left to give it. A card that divided
   * four among up to three would read "one, two, or three" the same way, and both are exactly
   * what the printed cards say.
   *
   * What a target that becomes illegal takes with it is its share, and nothing else (CR 608.2b):
   * the spell still resolves against the targets it has left, and the damage assigned to the one
   * that is gone is simply not dealt. It is not redistributed — a player who could move it would
   * be re-dividing after the window to respond had closed.
   */
  readonly divided?: number;
}

/**
 * When a triggered ability fires.
 *
 * `step` covers "at the beginning of your upkeep" and the end step. The rest are the events the
 * engine raises as it works, and adding a new one means raising it in the engine as well — which is
 * deliberate friction: a trigger nothing fires is worse than no trigger at all.
 */
export type TriggerEvent =
  | {
      readonly kind: 'etb';
      /**
       * Whose entry it watches. `self` — the default, and what most cards do — is the permanent's
       * own arrival. `another` is every creature *but* this one, and `any` is both, which is the
       * "~ or another creature" templating.
       */
      readonly who?: 'self' | 'another' | 'any';
      /** Who controls the permanent entering. Ignored for `who: 'self'`. */
      readonly of?: 'you' | 'opponent' | 'any';
      /**
       * What kind of permanent. `permanent` is the default because a `who: 'self'` trigger already
       * knows what its own card is — but a trigger watching the *board* almost always says
       * "creature", and without this an Impact Tremors fires for its own arrival as an enchantment.
       *
       * `land` is the landfall templating — "whenever a land you control enters" — and it is a
       * separate value rather than a filter because a land is not a creature and the two questions
       * are asked by different cards. A land entering has always raised this event; until a card
       * asked, nothing could hear it.
       */
      readonly what?: 'creature' | 'permanent' | 'land';
      /** Set by the engine when it raises the event. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine when it raises the event: whether the subject is a creature. */
      readonly subjectIsCreature?: boolean;
      /** Set by the engine when it raises the event: whether the subject is a land. */
      readonly subjectIsLand?: boolean;
      /** Set by the engine when it raises the event: *which* permanent entered. See `subject`. */
      readonly subject?: string;
    }
  | {
      readonly kind: 'dies';
      /** As `etb`: `self` is this creature dying, `another` is any other, `any` is both. */
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      readonly what?: 'creature' | 'permanent';
      /**
       * "a **nontoken** creature you control dies", which is how nearly every death payoff is
       * printed — and the clause that stops a deck of 1/1 tokens draining the table to zero by
       * accident. A token dying is still a creature dying; it is just not this trigger's business.
       */
      readonly nontoken?: boolean;
      readonly subjectSeat?: SeatIndex;
      readonly subjectIsCreature?: boolean;
      /** Set by the engine when it raises the event. */
      readonly subjectIsToken?: boolean;
      /** Set by the engine when it raises the event: *which* creature died. See `subject`. */
      readonly subject?: string;
    }
  | {
      readonly kind: 'attacks';
      /**
       * Whose attack it watches, exactly as `etb` and `dies`: `self` — the default, and what every
       * script written before this meant — is this permanent attacking, `another` is any other
       * creature, `any` is both.
       */
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /**
       * Set by the engine: what this attack was declared against.
       *
       * The one thing the other board-watching events do not need, and the reason it is on the
       * event rather than looked up on resolution: "deals 1 damage to the player or planeswalker
       * it's attacking" is about *that* attack, and by the time the trigger resolves the creature
       * may be dead, the attack may have been removed from combat, and the board will not say
       * what it was aimed at.
       */
      readonly attacked?: AttackedTarget;
      /**
       * Whether this creature was the only one declared as an attacker (CR 702.90b).
       *
       * One field read from both sides, because there is only one question: the engine writes it
       * on the event, and a trigger that asks for `alone: true` fires only when it was. Exalted
       * is the whole reason it exists, and exalted is unusual in caring — "attacks alone" is a
       * fact about the *declaration* and not about the creature, so nothing on the board can be
       * read later to find it out.
       */
      readonly alone?: boolean;
      /** Set by the engine when it raises the event: *which* creature attacked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * This permanent has left the battlefield, however it left (CR 603.6c) — destroyed, exiled,
   * bounced or sacrificed. Only its own script can care, which is why it takes no `who`: a card
   * that wants to watch *another* permanent leave would be watching the board rather than itself,
   * and nothing in the pool does.
   */
  | { readonly kind: 'leaves' }
  | { readonly kind: 'becomes-tapped' }
  /**
   * "When this permanent is turned face up" — morph's own trigger (CR 702.37d).
   *
   * Its own permanent only, like `becomes-tapped`: a card that watched somebody *else's* morph
   * turn over would be reading the board, and nothing is printed that does.
   *
   * It is **not** an entry trigger, and that is the whole reason it exists as its own kind. A
   * morph entered the battlefield face down, turns after the fact, and is not a new object when it
   * does — so an `etb` trigger has already fired and will not fire again, and a card whose text
   * only works once it is face up has nowhere else to hang. The two are a pair of opposites worth
   * saying out loud: an entry trigger on a morph fires while the card has no abilities to fire it,
   * and this one fires when the card gets them.
   */
  | { readonly kind: 'turned-face-up' }
  /**
   * "Whenever ~ deals combat damage to a player."
   *
   * To a *player*, always: that is the half of the templating the cards in this pool use and the
   * half the engine records. Damage to a creature or a planeswalker raises nothing, which is said
   * out loud here because the shorter name would promise more than it does.
   *
   * Its own permanent only — like `becomes-tapped` and unlike a death, which the whole battlefield
   * may watch. Nothing is printed that watches somebody *else's* creature connect, and a trigger
   * nothing fires is worse than no trigger at all.
   *
   * The seat that was hit reaches the ability through `EffectContext.attacked`, the same channel an
   * attack trigger uses: `c.attacked.defender` is "the player this event was about". In a duel that
   * is the only opponent; in a pod it is the one who was actually attacked, which is the whole
   * reason it travels rather than being worked out.
   */
  | { readonly kind: 'combat-damage'; readonly defender?: SeatIndex }
  | {
      readonly kind: 'spell-cast';
      readonly by?: 'you' | 'opponent' | 'any';
      /**
       * Which spells count. `noncreature` is prowess; `instant-or-sorcery` is the narrower one
       * Talrand and friends want, and it is a separate option rather than being folded into
       * `noncreature` because an artifact is a noncreature spell and is not an instant.
       */
      readonly spell?: 'creature' | 'noncreature' | 'instant-or-sorcery' | 'any';
      /** Set by the engine when it raises the event: the spell's card types, lowercased. */
      readonly types?: readonly string[];
    }
  /**
   * "Whenever this permanent becomes the target of a spell or ability" (CR 115.7, CR 702.21b).
   *
   * Its own permanent only, like `becomes-tapped`: a card that watched *another* permanent being
   * targeted would be watching the stack rather than itself, and nothing is printed that does.
   *
   * `by` is the half that matters, and it defaults to `opponent` rather than to `you` — the
   * opposite of every other event here. Ward is the only reason this exists and ward never
   * triggers off its own controller's spells, so the default is the one that is right for the one
   * caller; a card that wanted both would say `any` out loud.
   */
  | {
      readonly kind: 'targeted';
      readonly by?: 'you' | 'opponent' | 'any';
      /** Set by the engine when it raises the event: the stack object that did the targeting. */
      readonly object?: string;
    }
  | { readonly kind: 'life-gained'; readonly by?: 'you' | 'any' }
  | { readonly kind: 'step'; readonly step: Step; readonly of?: 'you' | 'any' }
  /**
   * A Saga's chapter, which fires when its lore counter *reaches* this number (CR 714.2b).
   *
   * Not a step trigger and not an entry trigger, and it is worth being clear why neither would do.
   * A step trigger would fire on a turn the Saga had already finished, and would fire on the same
   * chapter twice if the counters were ever changed by something else. An entry trigger fires once,
   * at a moment, and a Saga's whole shape is that it says three different things on three different
   * turns. The counter is the state and the chapter is what reaching a number *means*.
   *
   * `n` is the chapter the ability is printed as: I is 1. Two chapters may share a number only by
   * being written as one ability, the way the printed cards do ("I, II — ...").
   */
  | { readonly kind: 'chapter'; readonly n: number };

/**
 * A question a card asks *while it is resolving* (CR 608.2).
 *
 * The distinction from a `TargetSpec` is the whole point. A target is chosen as the spell goes on
 * the stack, by its controller, from a public zone, and an opponent may respond to it. A decision
 * is made as the spell resolves, possibly by somebody else, possibly from a hidden zone, and
 * nobody can respond — the spell is already resolving. Writing "search your library for a creature
 * card" as a target would get every one of those wrong.
 *
 * The engine asks each spec in turn and hands the answers to the effect as `ctx.decisions`, in the
 * same order. A spec whose zone turns out to hold nothing it would accept is not asked at all: a
 * prompt with no answer is a stuck game, which is exactly what the old graveyard-targeting bug was.
 */
/**
 * A question a card asks while it is resolving, and whose answer is a set of **cards**.
 *
 * One of the two shapes of `DecisionSpec`. See `ChoiceDecisionSpec` for the other.
 */
export interface CardsDecisionSpec {
  /**
   * Who chooses. "Target player discards two cards" is chosen by the player discarding, not by the
   * caster — getting that wrong would make Mind Rot a very different card. `each-player` and
   * `each-opponent` expand into one question each, asked in turn order starting from the active
   * player (CR 101.4), because who answers first is sometimes the whole card: the second player to
   * sacrifice has seen what the first gave up.
   */
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent';
  /**
   * Which zone, from the chooser's own side. `library` is a search: the chooser may look through
   * the whole library while deciding, as they would at a table, and it is shuffled afterwards
   * (CR 701.19e) — which is also what stops them keeping the order they just read.
   */
  readonly from: DecisionZone;
  /**
   * For `library-top`: how many cards off the top the question is about. Ignored everywhere else.
   *
   * The cards not chosen stay on top in the order they were already in. That is scry as far as
   * this engine goes — the printed keyword also lets you reorder the ones you keep, which needs a
   * question whose answer is a sequence rather than a set, and no card in the pool turns on it.
   */
  readonly look?: number;
  /** Shown to whoever is choosing, in their own words: "Search your library for a creature card". */
  readonly prompt: string;
  /** Both default to 1, and both are clamped to what the zone actually holds. */
  readonly min?: number;
  readonly max?: number;
  /** Which cards in that zone qualify. Without one, any card in the zone does. */
  readonly filter?: (state: GameState, id: string, chooser: SeatIndex) => boolean;
  /** Never set on this shape; it is what tells the two apart. */
  readonly options?: never;
}

/**
 * A question whose answer is a **word**: a creature type, a colour, "tap" or "untap", yes or no.
 *
 * The other half of what printed cards ask, and the half this engine could not say until now.
 * Everything in `CardsDecisionSpec` is about objects in a zone, and "choose a creature type" names
 * no object at all — so a card that wanted one had to be left out of the pool rather than
 * approximated.
 *
 * One shape for all of them rather than a separate yes-or-no: "you may" is a choice between two
 * words, the table draws the same row of buttons either way, and a single mechanism is a single
 * place for the rules about it to live. A spec with fewer than two options is answered by the
 * engine rather than asked, for the same reason a discard of two cards from a hand of two is —
 * a prompt with one button is noise.
 */
export interface ChoiceDecisionSpec {
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent';
  readonly prompt: string;
  /** The words, in the order the table shows them. The first is the default a bot falls back on. */
  readonly options: readonly string[];
  /**
   * Which word the engine's own opponent picks, written by the card.
   *
   * It has to live here, because only the card knows what its words *mean*: "Vampire" is a
   * creature type to count on a battlefield and "white" is a colour to fear in a graveyard, and
   * nothing generic can tell those two lists apart without guessing. So the card answers its own
   * question the way a player would, from the board — which is the same rule the rest of the bot
   * follows: read a fact, do not carry a weight.
   *
   * Never shown to a person, and never consulted when a person is answering. Returning
   * `undefined` falls back to the first option, which is why the order of `options` is not
   * arbitrary.
   */
  readonly best?: (state: GameState, chooser: SeatIndex) => string | undefined;
  /** Never set on this shape; it is what tells the two apart. */
  readonly from?: never;
}

export type DecisionSpec = CardsDecisionSpec | ChoiceDecisionSpec;

/** Whether a question is the kind whose answer is a word. Narrows for TypeScript as well. */
export const isChoiceDecision = (spec: DecisionSpec): spec is ChoiceDecisionSpec =>
  spec.options !== undefined;

/**
 * A yes-or-no question asked of the board, for an intervening-if clause. See `TriggerDef.condition`.
 *
 * The same context an effect gets, so that the condition and the effect read the same board the
 * same way — a condition that answered from a narrower view than its effect could say yes to
 * something the effect then cannot do.
 */
export type ConditionFn = (ctx: Parameters<EffectFn>[0]) => boolean;

export interface TriggerDef {
  readonly on: TriggerEvent;
  readonly description: string;
  /**
   * The intervening-if clause: "**if** that creature's power is greater than this creature's, put
   * a +1/+1 counter on it" (CR 603.4).
   *
   * Not a filter on the event, and the difference is the whole rule. A condition here is checked
   * twice — once when the trigger would go on the stack, and again as it resolves — and if it is
   * false either time the ability does nothing at all. So an evolve trigger whose creature was
   * killed in response does not put a counter on, and a trigger that would not have fired is
   * never put on the stack for an opponent to respond to.
   *
   * It is given the same context an effect is, which is what makes it able to answer the question
   * at all: `ctx.subject` is the creature the event was about, and `ctx.source` is the card
   * asking. A condition must not change the game — it is asked, not run.
   */
  readonly condition?: ConditionFn;
  readonly targets?: readonly TargetSpec[];
  /** Questions asked while it resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpec[];
  /** What it does before those questions are asked. See `CardScript.beforeDecisions`. */
  readonly beforeDecisions?: EffectFn;
  readonly effect: EffectFn;
}

export interface AbilityCost {
  /** Mana part, in the printed `{1}{R}` form. */
  readonly mana?: string;
  /** The `{T}` symbol: requires the permanent to be untapped and not summoning sick. */
  readonly tap?: boolean;
  readonly sacrificeSelf?: boolean;
  /**
   * "Sacrifice a creature:" — the player picks which, and it is gone before the ability is on the
   * stack. A **cost**, not a target: it cannot be responded to, and an opponent cannot save the
   * creature in reply. Modelling it as a target would be close enough to look right and wrong
   * exactly where it matters.
   */
  readonly sacrifice?: 'creature' | 'another-creature';
  /**
   * "Pay 1 life:" — life as part of the cost rather than as something the ability does.
   *
   * The difference is not cosmetic. A cost is paid as the ability is activated and cannot be
   * responded to, and an ability whose cost you cannot pay is never offered at all — so a player
   * on one life is not shown a Mana Confluence's mana, where "it deals 1 damage to you" on a City
   * of Brass would happily take them to zero. That is the printed difference between those two
   * cards, and it is the reason both of them are in the pool.
   */
  readonly life?: number;
  /**
   * A planeswalker's loyalty cost: `+1`, `0`, `-3`. Paid by adding or removing loyalty counters
   * as the ability is activated (CR 606.2), which is why a minus ability cannot be used without
   * the loyalty to pay for it — and why using one is how a planeswalker runs out.
   *
   * Sorcery speed and once per turn per planeswalker are implied by the cost existing, rather
   * than asked for separately: every loyalty ability in the game has both restrictions.
   */
  readonly loyalty?: number;
  /**
   * "Discard this card:" — the card itself is the cost, which is what makes cycling work.
   *
   * It carries its own restrictions, the way `loyalty` does: an ability that discards the card to
   * pay for it is used **from the hand**, and nowhere else. Nothing in Magic discards itself from
   * the battlefield to pay for something, and a script that had to say "from hand" separately
   * would be one more thing to forget. The card is in the graveyard by the time the ability
   * resolves (CR 702.29a), which is why the ability's effect must not read its own source.
   */
  readonly discardSelf?: boolean;
  /**
   * "Crew N" — tap any number of untapped creatures you control with total power N or greater
   * (CR 702.122a).
   *
   * The third kind of cost in this engine that is not mana, after the sacrifice and the life, and
   * the second that is paid by tapping somebody else's permanent — convoke was the first. What it
   * is *not* is a tap cost on the Vehicle: the Vehicle stays untapped, which is the whole point,
   * because it is about to attack.
   *
   * Two rules travel with it rather than being asked for separately. Summoning sickness does not
   * stop a creature crewing, because tapping it is a cost being paid and not an ability it is
   * activating (CR 302.6 is about {T} abilities and attacking). And **any number** means the count
   * is the engine's to choose, like convoke's: see `crewPlan`.
   */
  readonly crew?: number;
}

export interface AbilityDef {
  readonly cost: AbilityCost;
  readonly description: string;
  readonly targets?: readonly TargetSpec[];
  /**
   * A mana ability. It produces these types, resolves immediately and never uses the stack
   * (CR 605.3a) — which is what makes tapping a land for mana in response to something work.
   */
  readonly produces?: readonly ManaType[];
  /** Questions asked while it resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpec[];
  /** What it does before those questions are asked. See `CardScript.beforeDecisions`. */
  readonly beforeDecisions?: EffectFn;
  readonly effect?: EffectFn;
  /** Only activatable when you could cast a sorcery. */
  readonly sorcerySpeed?: boolean;
  /**
   * See `CardScript.preventsDamage`. On the ability because that is what is spent: a Samite
   * Healer's ability taps it, so using it when no damage is coming costs a blocker for nothing,
   * while the creature itself is a perfectly good play.
   */
  readonly preventsDamage?: boolean;
  /**
   * "This ability turns the permanent into a creature until end of turn" — layer 4, bought with
   * mana.
   *
   * Declared for the bot, and the eighth member of the "spent on nothing" family. The evaluation
   * cannot see what animating a land buys: a Mutavault that is a 2/2 still scores as a land, so
   * the gain is zero and the mana is free — and with no baseline for doing nothing, the search
   * pressed it whenever it had a spare {1}. Measured before the rule: **854 animations in 56
   * games, and not one attack with it.** The question the board is asked instead is whether there
   * is an attack to make or a block to make; see `animationCouldMatter`.
   */
  readonly animates?: boolean;
}

/** An Aura: what it may enchant, and what it does to the thing it is attached to. */
export interface AuraDef {
  readonly target: TargetSpec;
  readonly effect: PumpOptions;
}

/** One mode of a modal spell: what it says, what it points at, and what it does. */
export interface ModeDef {
  /** The mode as printed, e.g. "Exile target creature with power 5 or greater". */
  readonly description: string;
  readonly targets?: readonly TargetSpec[];
  /** Questions asked while this mode resolves. See `DecisionSpec`. */
  readonly decisions?: readonly DecisionSpec[];
  readonly effect: EffectFn;
  /**
   * See `CardScript.expiresAtEndOfTurn`. On the mode rather than the card, because a charm's other
   * modes are not pumps: Selesnya Charm exiles a big creature or makes a token, and holding it
   * back for a combat would be wrong for either.
   */
  readonly expiresAtEndOfTurn?: boolean;
  /**
   * See `CardScript.preventsDamage`. On the mode for the same reason: Healing Salve's other mode
   * gains three life, which is never spent on nothing the way a shield is — the life stays until
   * something takes it, so dropping the whole card when no damage is coming would throw away the
   * half that was fine.
   */
  readonly preventsDamage?: boolean;
}

/**
 * "Choose one —", and the handful of shapes around it.
 *
 * Modes are chosen **as the spell is cast** (CR 601.2b), before its targets (CR 601.2c) — not
 * while it resolves. That is the whole reason this is not a `DecisionSpec`: which mode you take
 * decides what the spell is allowed to point at, and an opponent gets to see both before they
 * respond. Scripting a mode as a mid-resolution decision would let a player counter a Charm
 * without knowing what it was going to do, which is a different and much better card.
 *
 * Because the choice travels with the cast, no new engine phase was needed and the table needed no
 * new interface: `legalActions` offers **one play per legal combination of modes**, which is a
 * shape it already had for a permanent with several abilities. A combination whose targets cannot
 * be filled is not offered at all, so "Choose one — destroy target creature; or draw two cards"
 * offers only the draw when there is no creature on the board.
 *
 * `min` and `max` default to 1, which is "choose one". `max: 2` over two modes is "choose one or
 * both"; `min: 2, max: 2` over four is "choose two". Both are clamped to the number of modes.
 */
export interface ModalDef {
  readonly modes: readonly ModeDef[];
  readonly min?: number;
  readonly max?: number;
}

export interface CardScript {
  /** Matched case-insensitively against the card's printed name. */
  readonly name: string;
  /** Keywords the card has, overriding what would be read from its oracle text. */
  readonly keywords?: readonly Keyword[];
  /**
   * Convoke (CR 702.51): each creature tapped as this is cast pays one generic mana, or one mana of
   * that creature's colour.
   *
   * A flag rather than a cost, because it does not change what the spell costs — it changes what
   * may pay for it. `convokePlan` works out which creatures, and taps none that the lands already
   * cover.
   */
  readonly convoke?: boolean;
  /** What the spell targets when cast. For a modal spell the targets live on each mode. */
  readonly targets?: readonly TargetSpec[];
  /** "Choose one —". See `ModalDef`. */
  readonly modal?: ModalDef;
  /**
   * Questions asked while the spell resolves, answered before `onResolve` runs. See `DecisionSpec`.
   */
  readonly decisions?: readonly DecisionSpec[];
  /**
   * What the spell does *before* its questions are asked.
   *
   * "Draw two cards, then discard two cards" cannot ask first: the cards it offers to discard are
   * the ones it has not drawn yet. So a card whose question depends on what it has already done
   * puts that half here, the engine asks, and `onResolve` finishes with the answers. Only useful
   * alongside `decisions` — without them it is just a slower `onResolve`.
   */
  readonly beforeDecisions?: EffectFn;
  /** What happens when the spell resolves. A permanent enters the battlefield either way. */
  readonly onResolve?: EffectFn;
  readonly aura?: AuraDef;
  /**
   * "Enters the battlefield tapped": a replacement effect (CR 614.1c) rather than a trigger, so
   * the permanent is never untapped and nothing can be done with it on the way in.
   */
  readonly entersTapped?: boolean;
  /**
   * "This spell's whole effect is mana": a ritual, and Dark Ritual is the only one in the pool.
   *
   * Nothing in the engine reads it — the mana goes in the pool through `addToPool` like any other
   * mana, and the solver never needs to know where it came from. It is here for the *bot*, which
   * does: mana empties at the end of the step (CR 500.4), so a ritual cast with nothing to spend
   * it on is a card put in the graveyard for nothing, and the search has no other way to tell a
   * spell that did nothing from a spell whose effect it cannot see. Measured before the bot knew:
   * cast 35 times in 120 unsteered games, followed by a spell in the same step 3 times.
   *
   * Declared rather than inferred because inferring it is wrong twice over: the pool in a
   * simulated line can be empty because the step ended, and a permanent that makes mana is a
   * different card that the evaluation already prices correctly.
   */
  readonly makesMana?: boolean;
  /**
   * "This spell's whole effect is to prevent combat damage" — a Fog, and its white reprint.
   *
   * Declared for the bot, like `makesMana`, and for the same reason twice over. A Fog cast with
   * nothing attacking is a card in the graveyard, and the evaluation sees a card leaving the hand
   * either way; and the state *after* the cast cannot be asked, because with auto-pass on a spell
   * nobody can respond to resolves inside the same action and the engine keeps passing — a line
   * that ends the turn has already expired the effect the question was about. That mistake was
   * made first, measured (21 Fogs cast, 11 of them into an empty board) and replaced by this.
   *
   * Not on Maze of Ith, which needs no flag: its ability can only target an attacking creature, so
   * the engine does not offer it when there is nothing to prevent.
   */
  readonly preventsDamage?: boolean;
  /**
   * "This card's whole point is to become a copy of a creature" — a Clone.
   *
   * The sixth of the family, and the one whose waste is the most literal: a Clone cast with nothing
   * on the battlefield to copy is a 0/0 that dies as it arrives, four mana for a card in the
   * graveyard. The search should see that — it plays the cast out and the state-based actions kill
   * it inside the same action — and measured over 24 duels it mostly does: nine Clones cast, eight
   * of them with a creature on the table and one into an empty board. The one is the auto-pass trap
   * again, so the board is asked instead of the state after.
   */
  readonly copiesACreature?: boolean;
  /**
   * "This card's whole effect is to remove a creature" — a Doom Blade, a Pacifism, a Turn to Frog.
   *
   * The seventh of the family, and the one found by *playing the mistake out* rather than by
   * counting it. Over 60 duels the bot aimed removal at its own creature seven times, and six of
   * those had **no enemy creature on the board at all**: a Doom Blade on its own Talrand, a
   * Pacifism on its own Serra Angel, a Swords to Plowshares on its own Soul Warden. So the waste
   * is not a mis-aimed spell — it is a spell cast when there was nothing to kill, and the only
   * legal target left was its own side.
   *
   * The search cannot see it for the reason the whole family exists: killing your own creature
   * scores worse than passing, but with auto-pass on, the state after a one-mana instant can be a
   * turn later, and two positions a turn apart do not compare. So the board is asked instead: is
   * there a creature this seat does not control?
   *
   * Not for a card that is good without a creature to kill. A Lightning Bolt can hit a player, a
   * Man-o'-War is a body, and an Unsummon aimed at your own creature is a trick that saves it from
   * removal — none of those is this flag.
   */
  readonly removesACreature?: boolean;
  /**
   * "This spell's whole effect is to keep one of your own creatures alive" — a protection trick.
   *
   * The third of the family, and the one whose measurement was the most lopsided: 64 cast across
   * 160 games and **60 of them with nothing on the stack and no combat in progress**, which is a
   * card thrown away to give a creature +2/+2 until end of turn for no reason at all.
   *
   * It is not the search's fault. The evaluation sees a creature get bigger and a card leave the
   * hand, and both of those are true; what it cannot see is that the bigger creature stops being
   * bigger in a minute. The *board* can say whether the card could matter — is something pointing
   * at one of my creatures, or is there a combat with one of my creatures in it — and that is a
   * fact rather than a weight, which is the line D74 drew.
   *
   * The rule also does something the measurement did not predict: it leaves the card in hand for
   * the moment it is for. Held rather than spent, the search finds it when an opponent's removal
   * is on the stack, because then "cast it" and "pass" play out to different boards.
   */
  readonly protectsACreature?: boolean;
  /**
   * "This spell's whole effect wears off at end of turn" — a pump.
   *
   * The fourth and last of the family, and the one with the widest measurement behind it. Across
   * 160 unsteered games the five pumps in the pool were cast 95 times and **not once during a
   * combat**: 59 of them in the caster's own upkeep or draw step, before a land had been played,
   * on a board where nothing could possibly be attacking.
   *
   * It is the search's horizon rather than its judgement. A cast is scored with `simulate`, which
   * stops when the stack empties, so "+3/+3 until end of turn" is read as a creature that is
   * bigger *now*; the combat it was printed for is past where the simulation looks.
   * `scoreDeclaration` does play through combat, which is why the same bot blocks and attacks
   * well — the gap is only on the cast.
   *
   * So the rule is not "a pump is bad" but **"do not spend now what you can spend better later"**.
   * An instant can wait for blockers; a sorcery cannot wait past this main phase, so one is
   * allowed precombat when there is something to attack with. The bot held nothing back before
   * this and has no other way to learn it: the card is gone two steps before the question.
   */
  readonly expiresAtEndOfTurn?: boolean;
  /**
   * "This spell's whole effect is to goad other people's creatures" — Disrupt Decorum.
   *
   * The fifth of the family and the only one that is about the *table* rather than the board: goad
   * makes a creature attack somebody other than you, so with one opponent there is nobody else and
   * the card does the opposite of what it is for. Paying four mana to be attacked is not a line a
   * search can find its way out of either, because `simulate` stops at the end of this combat and
   * the attack goad forces comes on somebody else's turn — the same horizon that hid the pumps.
   *
   * Declared rather than inferred for the usual reason: "it goads" is a fact about the card, while
   * "there is more than one opponent" is a fact about the board, and the bot asks the board.
   */
  readonly goadsOpponents?: boolean;
  /**
   * What this Equipment gives the creature it is attached to.
   *
   * Declared rather than left inside the equip ability's own effect, because other cards read it:
   * a commander that moves every Equipment you control onto itself has to know what each of them
   * does, and a bonus closed over by one function cannot be asked.
   */
  readonly equipBonus?: PumpOptions;
  /**
   * "Enters the battlefield with N counters on it" (CR 614.1c), where N may be the X it was cast
   * for. A permanent that arrives any other way — reanimated, copied, made as a token — enters
   * with X of zero, which is the rule and not a shortcut.
   */
  readonly entersWith?: { readonly counter: string; readonly amount: number | 'x' };
  /**
   * Kicker: an optional additional cost, announced as the spell is cast (CR 702.32a).
   *
   * The third member of the family that already holds X and modes, and for the same reason: it is
   * chosen at cast time, both players can see it on the stack, and what it does cannot be decided
   * on resolution without letting a player counter a spell they could not read. The effect reads
   * `ctx.kicked` and branches — one effect function per card rather than two, because a kicked
   * spell is usually the same spell with a number changed.
   */
  readonly kicker?: {
    /** The extra mana, in the printed `{3}` form, on top of the card's own cost. */
    readonly cost: string;
    /** As printed: "Kicker {3}". */
    readonly description: string;
  };
  /**
   * Flashback: a second casting, out of the graveyard, for a different cost (CR 702.33).
   *
   * The second zone a spell is ever cast *from* in this engine — the command zone was the first,
   * and that one was a whole missing branch of `legalActions` when it went in. What makes flashback
   * more than a cost is the end of it: the card is **exiled instead of going anywhere else** as it
   * leaves the stack, countered or resolved, which is what stops a one-mana spell being an engine.
   *
   * Replaces the printed cost rather than adding to it, unlike the kicker, and keeps the card's own
   * timing: a sorcery with flashback is still a sorcery.
   */
  readonly flashback?: {
    /** The whole cost of the flashback casting, in the printed `{2}{U}` form. */
    readonly cost: string;
  };
  /**
   * Foretell: {2} to exile this from your hand face down, and a cheaper cost to cast it later
   * (CR 702.143).
   *
   * The fourth zone a spell is cast *from* in this engine, after the hand, the command zone and the
   * graveyard — and the only one where the card is **hidden** while it waits. An opponent sees a
   * face-down card in exile and knows only that it is something, which is most of what the mechanic
   * is for.
   *
   * Two rules travel with it rather than being asked for separately. Foretelling is a special
   * action taken during your own turn, so it is sorcery-speed by nature; and a foretold card cannot
   * be cast on the turn it was foretold (CR 702.143b), which is why `CardInstance.foretoldTurn`
   * exists. Both are checked in one place rather than left to the scripts.
   *
   * The cost here **replaces** the printed one, like flashback and unlike the kicker — and unlike
   * flashback, the card is not exiled afterwards: it was already in exile and it goes to the
   * graveyard like any other spell.
   */
  readonly foretell?: {
    /** The cost of casting it out of exile, in the printed `{1}{U}` form. */
    readonly cost: string;
  };
  /**
   * Morph: cast this face down as a 2/2 for {3}, and turn it up later for this cost (CR 702.37).
   *
   * Only the *turn-up* cost lives here. The face-down casting costs {3} for every card that has
   * morph, which is printed in the rule rather than on the card, so the engine holds it as a
   * constant and a script that tried to name a different one would be describing a card that does
   * not exist.
   *
   * What makes morph more than two costs is that both halves are already built: a face-down
   * permanent is a 2/2 with no abilities (CR 707.2), which `characteristicsOf` does by substituting
   * a profile for the card, and `isFaceDownPermanent` keeps its triggers, mana and abilities from
   * applying. Morph is the card-facing half of that — the cast, and the special action that turns
   * it over.
   *
   * Turning it face up is **not** casting it and does not use the stack (CR 702.37b): nobody may
   * respond, which is the point of the mechanic. It is also not a new object, so the creature keeps
   * its damage, its counters, whether it is tapped, what is attached to it, and how long it has
   * been on the battlefield — a morph that has been down since last turn can attack the moment it
   * is turned up.
   */
  readonly morph?: {
    /**
     * The whole turn-up cost, in the same vocabulary an activated ability's cost uses.
     *
     * An `AbilityCost` rather than a mana string, because a morph cost is not always mana: Zombie
     * Cutthroat's is "pay 3 life" and nothing else. Reusing the type rather than growing a second
     * one means the life clause's own rule comes with it — a cost you cannot pay is not a cost you
     * may pay, so a player on three life is not offered a turn-up that would kill them, which is
     * exactly what `AbilityCost.life` already says about Mana Confluence.
     *
     * Not every field of it makes sense here and the engine only pays the two that do, `mana` and
     * `life`. A `tap` on a turn-up cost would be a card that does not exist, and `crew` and
     * `loyalty` belong to other mechanics; a script asking for one of those gets nothing rather
     * than a quiet approximation, which is what `morphCostText` and `payMorphCost` both say.
     */
    readonly cost: AbilityCost;
    /**
     * Megamorph: turning it face up also puts a +1/+1 counter on it (CR 702.37c).
     *
     * One flag, because that is the whole difference between the two keywords. The counter is part
     * of the *same* action as the turn-up rather than something that happens afterwards — a
     * megamorph whose counter arrived from a trigger could be answered between the two halves, and
     * turning a permanent face up is specifically the thing nobody may respond to.
     */
    readonly mega?: true;
  };
  /**
   * An additional cost that is not optional: "As an additional cost to cast this spell, sacrifice
   * a creature."
   *
   * A **cost**, like the sacrifice on an activated ability: paid as the spell is cast, so it
   * cannot be responded to and the creature cannot be saved in reply. A spell whose additional
   * cost cannot be paid is not castable at all (CR 601.2h), which is why it is not offered rather
   * than offered and refused.
   */
  readonly additionalCost?: {
    readonly sacrifice: 'creature' | 'another-creature';
  };
  /**
   * A Saga: it enters with a lore counter, gains one at the beginning of its controller's
   * precombat main phase, and is sacrificed once its last chapter has resolved (CR 714).
   *
   * A flag rather than a chapter list, and the chapters live in `triggers` with
   * `on: { kind: 'chapter', n }` like any other triggered ability — which means they get targets,
   * mid-resolution questions and the stack for free, and means **the number of chapters is derived
   * from them** rather than declared beside them. A `chapters: 3` field that could disagree with
   * the triggers is a field that eventually does.
   *
   * The sacrifice is a state-based action and not a fourth chapter, which is the rule and also the
   * only version that behaves: a Saga whose last chapter is countered still goes away, because what
   * the game checks is the counters and an empty stack rather than whether an ability resolved.
   */
  readonly saga?: true;
  readonly triggers?: readonly TriggerDef[];
  readonly abilities?: readonly AbilityDef[];
  /**
   * Static effects the permanent creates while it is on the battlefield.
   *
   * The scope is a bare name for the four that need no argument, and an object for the one that
   * does: `{ subtype: 'Goblin', other: true }` is every lord ever printed. An object rather than
   * four more names, because the thing being named is a *parameter* — there is one subtype scope
   * and sixty creature types, and an enum of them is the mistake D57 is about.
   */
  readonly statics?: readonly {
    readonly scope:
      | 'self' | 'controller-creatures' | 'other-controller-creatures' | 'all-creatures'
      | { readonly subtype: string; readonly other?: boolean };
    readonly effect: PumpOptions;
  }[];
  /**
   * Replacement effects this permanent contributes, for an event happening to *another* object
   * (CR 614).
   *
   * The two replacement effects already in the engine — regeneration and "enters tapped" — are
   * shields that sit on the card they affect, and they got away with it because that is where they
   * are printed. "If a nontoken creature an opponent controls would die, exile it instead" cannot:
   * the effect belongs to one permanent and changes what happens to a different one, so there has
   * to be a *pass* that asks every permanent on the table whether it wants to replace what is
   * about to happen. This is the declaration side of that pass.
   *
   * `applies` is a predicate rather than a scope enum for the same reason `TargetSpec.filter` is:
   * every card words this differently — an opponent's, a nontoken one, a creature rather than a
   * permanent — and an enum would either be short of what the next card needs or carry values no
   * card uses, which D57 is the warning about.
   *
   * `instead` is handed the dying permanent and returns the state with it dealt with. It is run
   * before the death event is raised, so a replaced death is not a death and nothing triggers off
   * it — which is what the rules say and the whole reason this is a replacement rather than a
   * trigger of its own.
   */
  readonly replaces?: readonly {
    /** The only event this engine replaces. "Dies" is a permanent going to a graveyard from the
     *  battlefield (CR 700.4). */
    readonly on: 'dies';
    readonly description: string;
    readonly applies: (ctx: ReplacementContext) => boolean;
    readonly instead: (ctx: ReplacementContext) => GameState;
  }[];
}

/**
 * What a replacement effect is asked about: the permanent it is replacing the event for, and the
 * permanent whose effect this is.
 *
 * `dying` is already in its owner's graveyard when this runs, which is the shape of the engine's
 * answer to replacement effects generally — see `settle`. Read it for what the card *was*, not for
 * where it is.
 */
export interface ReplacementContext {
  readonly state: GameState;
  /** The permanent the event is happening to. */
  readonly dying: string;
  /** The permanent whose replacement effect this is. */
  readonly source: string;
  /** Who controls `source`. */
  readonly controller: SeatIndex;
}

export const targetCount = (spec: TargetSpec): number => Math.max(1, spec.count ?? 1);

/**
 * What every morph costs to cast face down: {3} (CR 702.37a).
 *
 * In the rule rather than on the card, so it is one constant rather than a field on each script —
 * and a constant both halves read, because `legalActions` offers the play and `castSpell` pays for
 * it, and this file exists to keep an offer and a payment from disagreeing.
 */
export const MORPH_COST = '{3}';

/**
 * A morph cost as a player reads it: "{2}{U}", "pay 3 life", or both.
 *
 * Here rather than in `legalActions` because the offer and the log both want the same sentence,
 * and two formatters would eventually disagree about one of them.
 */
export function morphCostText(cost: AbilityCost): string {
  const parts: string[] = [];
  if (cost.mana !== undefined && cost.mana !== '') parts.push(cost.mana);
  if (cost.life !== undefined) parts.push(`pay ${cost.life} life`);
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

/**
 * What foretelling costs: {2} (CR 702.143a).
 *
 * In the rule rather than on the card, like morph's {3}, and a constant both halves read —
 * `legalActions` offers the special action and the reducer pays for it.
 */
export const FORETELL_COST = '{2}';
