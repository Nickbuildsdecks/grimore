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
import type { CardDef } from './cards.js';
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
      /**
       * Set by the engine: the counters the permanent had **before** it left, by counter name.
       *
       * Last known information (CR 608.2h / 603.6e), and the one piece of it a card in this pool
       * actually needs: a Hangarback Walker has to make a Thopter for each +1/+1 counter it had,
       * and by the time its own death trigger resolves the card is in a graveyard with no counters
       * at all — `relocate` wipes them on the way out, which is the rule. Read in the effect as
       * `EffectContext.subjectCounters`. Nothing wider is snapshotted: when a card needs the power
       * it had, or the types, this is where that goes.
       */
      readonly subjectCounters?: Readonly<Record<string, number>>;
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
      /**
       * "Whenever this creature **and at least two other creatures** attack" — battalion's clause,
       * asked as a minimum size for the whole declaration (CR 702.102a).
       *
       * `alone` is the same question with the answer one, and the two are kept apart rather than
       * folded together because `alone: true` is five entries old and means something a number
       * cannot: *exactly* one. This is **at least** N, which is what every printed card that counts
       * attackers says.
       *
       * It has to travel on the event for exactly the reason `alone` does: a creature removed from
       * combat before the trigger resolves leaves a board that cannot be counted (CR 506.4), so the
       * size of the declaration is only knowable where the declaration happened.
       */
      readonly withAtLeast?: number;
      /** Set by the engine: how many creatures were declared as attackers in this declaration. */
      readonly declared?: number;
      /** Set by the engine when it raises the event: *which* creature attacked. See `subject`. */
      readonly subject?: string;
    }
  /**
   * "Whenever this creature blocks" — the blocker's half of the declaration (CR 509.1a).
   *
   * Raised once per block, so a creature that is allowed to block two attackers sees the event
   * twice, which is what the printed cards mean. The *blocking* creature is the subject, so `who`
   * and `of` mean exactly what they mean on `attacks`: a card watching its own block says nothing
   * and gets `self`.
   *
   * Which attacker it blocked travels on the event as `blocked`, for the same reason `attacks`
   * carries what it was aimed at: "**that creature** doesn't untap during its controller's next
   * untap step" is about the creature this block was against, and by the time the ability resolves
   * the board holds nothing that says which one that was — a second blocker may have been declared
   * on it, the attack may be gone from combat, and the blocker is just a tapped creature. Read in
   * the effect as `EffectContext.blocked`.
   */
  | {
      readonly kind: 'blocks';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the blocking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: which creature blocked. See `subject`. */
      readonly subject?: string;
      /** Set by the engine: the attacker it blocked. See `EffectContext.blocked`. */
      readonly blocked?: string;
    }
  /**
   * "Whenever this creature becomes blocked by a creature" (CR 509.1h).
   *
   * The attacker is the subject and each blocker travels as `blocked`, which is the same pair of
   * roles the `blocks` event has and the opposite way round — so a card with both ("whenever ~
   * blocks **or becomes blocked by** a creature") reads `c.blocked` in either case and means the
   * other creature both times.
   *
   * Raised **once per blocker**, which is what "by a creature" means: a basilisk blocked by three
   * creatures destroys all three. Note the plain "becomes blocked", with no "by a creature", is a
   * different trigger that fires once however many blockers there are — nothing in the pool is
   * printed that way, and a card that was would want a separate event rather than this one with a
   * flag.
   */
  | {
      readonly kind: 'becomes-blocked';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: which creature became blocked. See `subject`. */
      readonly subject?: string;
      /** Set by the engine: one of the creatures blocking it. See `EffectContext.blocked`. */
      readonly blocked?: string;
    }
  /**
   * "Whenever this creature attacks and isn't blocked" (CR 509.1h).
   *
   * Not a filter on `attacks`, and the difference is the whole of the event: an attack trigger
   * fires as attackers are declared, when nobody has blocked yet and the answer is not knowable.
   * This one is raised at the end of the declare-blockers step, once every defender has said what
   * it is doing, which is the only moment at which "isn't blocked" is a fact.
   *
   * Carries `attacked` for the same reason `attacks` does — the ability may want the player it is
   * through to — and nothing else: the subject is the attacker, and there is no blocker to name.
   */
  | {
      readonly kind: 'attacks-unblocked';
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      /** Set by the engine: the seat that controls the attacking creature. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine: what the attack was declared against. */
      readonly attacked?: AttackedTarget;
      /** Set by the engine: which creature attacked. See `subject`. */
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
       * "When you cast **this** spell" — the card's own cast, watched from the stack (CR 603.2d).
       *
       * The one trigger in this engine that does not fire from the battlefield. Every other
       * watcher is a permanent in play; this one is the spell itself, sitting on the stack with its
       * own ability going on top of it, which is what cascade, storm, replicate and conspire all
       * abbreviate. `raise` includes the card being cast in the watcher list **only** for triggers
       * that set this, so an ordinary cast watcher — a Guttersnipe, a prowess creature — cannot
       * accidentally fire off its own casting on the way to the battlefield.
       *
       * It implies the caster is you, so `by` is not asked: a spell is cast by its own controller.
       */
      readonly self?: true;
      /**
       * Which spells count. `noncreature` is prowess; `instant-or-sorcery` is the narrower one
       * Talrand and friends want, and it is a separate option rather than being folded into
       * `noncreature` because an artifact is a noncreature spell and is not an instant.
       */
      readonly spell?: 'creature' | 'noncreature' | 'instant-or-sorcery' | 'any';
      /** Set by the engine when it raises the event: the spell's card types, lowercased. */
      readonly types?: readonly string[];
      /**
       * Set by the engine: the spell on the stack, so a trigger can read it or answer it.
       *
       * The `spell` and `types` fields above say what *kind* of spell was cast, which is all
       * prowess and Talrand ever needed. This is *which one*, and it is what a card has to have to
       * say "counter **it**" — a Chalice of the Void reads the spell's mana value and counters that
       * spell, and neither half is expressible from a kind. It reaches the ability as
       * `EffectContext.answering`, the same channel ward uses for the spell that targeted it.
       */
      readonly object?: string;
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
  /**
   * "Whenever you draw a card" (CR 121.2), and the opponents' half of it.
   *
   * One event per card, so "draw three cards" fires it three times. `by` works the way it does on
   * `spell-cast` rather than the way it does on `life-gained`: `you` is the default, `opponent` is
   * Underworld Dreams, and `any` is a card that does not care whose draw it was.
   *
   * It does **not** fire for a card put into a hand by anything other than a draw — a tutor, a
   * Gravedigger, a Man-o'-War. That is the rules rather than a simplification, and it is the whole
   * reason the event is recorded where a draw happens instead of being noticed afterwards. See
   * `GameState.drew`.
   */
  | { readonly kind: 'draws'; readonly by?: 'you' | 'opponent' | 'any' }
  /**
   * "Whenever another card is put into a graveyard from anywhere" (CR 400.7).
   *
   * The wider half of `dies`, and the four ways it happens are four different callers: a permanent
   * destroyed, a card milled off a library, a card discarded out of a hand, and a spell that has
   * finished resolving. Only the first of those is a death, which is why this is its own event and
   * not a `who` on that one — see `GameState.toGraveyard`.
   *
   * **`who` defaults to `another`, which is the opposite of every other event here**, and the
   * default is the card rather than a convention: Planar Void was written first and says "another
   * card", so a trigger that says nothing means what that card means. `self` is Rancor — "when
   * Rancor is put into a graveyard from anywhere, return it to its owner's hand" — which is the
   * one shape that needs a watcher to fire from the graveyard it has just reached, the way a
   * `dies` trigger fires from the one its creature is in.
   *
   * There is still no `by` and no `what`. Both would be fields nothing fires, and the rule this
   * engine keeps is that an option with no card behind it is worse than no option: `becomes-tapped`
   * is the trigger with no card at all and it is deliberate, `draws` has no `any` for the same
   * reason. The day a card wants "whenever a *creature* card is put into *your* graveyard", the
   * event already carries the subject and the seat to ask with.
   */
  | {
      readonly kind: 'to-graveyard';
      /**
       * Which card the trigger is about: `another` (the default, Planar Void), `self` (Rancor), or
       * `any`. The same three words the five board events take, so a reader who knows one knows
       * this — except for the default, which is `another` here and `self` there.
       */
      readonly who?: 'self' | 'another' | 'any';
      /**
       * Set by the engine when it raises the event: **which** card arrived in a graveyard, so the
       * ability can say "exile that card" (CR 400.7). Read through `EffectContext.subject`, the
       * same channel exalted and evolve read their creature through.
       */
      readonly subject?: string;
      /** Set by the engine: whose graveyard it arrived in. Nothing reads it yet; see above. */
      readonly subjectSeat?: SeatIndex;
    }
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
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly options?: never;
  readonly range?: never;
  readonly retargets?: never;
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
  /**
   * A **mana cost the engine pays** when this word is the answer (CR 601.2h).
   *
   * The shape extort needed and the first optional cost in this engine that is paid *during* a
   * resolution rather than as something is cast or activated. "You may pay {W/B}. If you do, each
   * opponent loses 1 life" is one question with a price on one of its two answers, and the card
   * cannot pay it itself: paying means tapping lands, which is the engine's job — see `payFrom`.
   *
   * Two rules make it behave. The option is **not offered** when the seat cannot pay for it, which
   * is the same discipline `legalActions` keeps about every other play, and leaves a one-word
   * question that the engine answers without a prompt. And the payment happens **before the
   * effect**, so an effect that reads `chosenOption` is reading an answer that has already been
   * paid for.
   */
  readonly payIfChosen?: { readonly option: string; readonly cost: string };
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly range?: never;
  readonly retargets?: never;
}

/**
 * A question whose answer is a **number**: "pay X life", "choose a number".
 *
 * The third and last shape of mid-resolution question, and the one this engine has been missing
 * since it learned to ask the other two. A card is not an answer and neither is a word: Toxic
 * Deluge's whole card is a number chosen *as it resolves*, bounded by the life its caster can
 * actually pay, and spent before anything else happens.
 *
 * It is not an X cost, which is the distinction worth being careful about. X is chosen as a spell
 * is **cast**, it is part of what gets countered, and an opponent sees it before deciding whether
 * to respond. A number chosen on resolution is chosen *after* every response, from a board that
 * may have changed — which is exactly why a player would rather have it that way, and why this
 * cannot be folded into `xMax`.
 *
 * **The card decides the range**, because only the card knows what the number means. Toxic Deluge
 * asks for nought up to the smaller of "life you can survive paying" and "the biggest toughness on
 * the board", since -9/-9 and -4/-4 kill exactly the same creatures when nothing has five
 * toughness — and a question offering forty answers where six matter is a worse question, not a
 * more honest one. The range is computed when the question is asked, so it reads the board as it
 * is at that moment rather than as it was when the spell was cast.
 */
export interface NumberDecisionSpec {
  readonly who: 'controller' | 'target-player' | 'each-player' | 'each-opponent';
  readonly prompt: string;
  /** The numbers on offer, inclusive, read off the board when the question is asked. */
  readonly range: (state: GameState, chooser: SeatIndex) => { readonly min: number; readonly max: number };
  /**
   * Which number the engine's own opponent picks, written by the card — the same hook, and for the
   * same reason, as `ChoiceDecisionSpec.best`: only the card knows what its number *buys*. Out of
   * range or absent falls back to the bottom of the range, which is the answer that does least.
   */
  readonly best?: (state: GameState, chooser: SeatIndex) => number | undefined;
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly options?: never;
  readonly retargets?: never;
}

/**
 * A question whose answer is a **target**: "you may choose new targets for the copy".
 *
 * The fourth and last shape, and the only one about an object that is not the card asking. Every
 * printed copy effect — Twincast, Reverberate, Fork, Strionic Resonator, Lithoform Engine — ends
 * with that clause, and until this existed the engine had to leave it off: the copy kept whatever
 * the original chose, which is a strictly worse card and was asserted as a limitation rather than
 * fixed.
 *
 * It cannot be a cast-time target, which is the distinction that makes this a shape of its own.
 * Swerve and Willbender *do* choose where a spell is going as they are cast, and they are
 * different cards for it: both targets are announced on the stack and both can be answered. A copy
 * effect chooses after every response, from the board as it ended up — a creature that arrived
 * since is a legal new target, and one that died is not.
 *
 * **The question is asked about the object being copied, not about the copy**, which is the one
 * design decision here worth writing down. A copy's characteristics are the original's (CR 707.2),
 * so its legal targets are the same set, and asking before the copy exists means the answer can
 * simply be handed to `copySpellOnStack` — rather than making a copy aimed at the old target and
 * re-aiming it, which is two states where one will do.
 *
 * Only an object with a **single** target is offered the question, which is the same restriction
 * `soleTargetSpecOf` puts on Swerve and Willbender and for a sharper reason here: the rules copy a
 * divided quantity as it was divided (CR 706.10c), so a re-aimed Arc Lightning would need its
 * three points re-divided as well, and "choose new targets" is not permission to re-divide. An
 * object with no targets, with several, or with only one legal target to choose is not asked.
 */
export interface TargetDecisionSpec {
  readonly who: 'controller';
  readonly prompt: string;
  /**
   * Which object on the stack this question is about, read off the resolution that is asking.
   *
   * Twincast and the Resonator both answer `object.targets[0]?.id`: the spell or ability they were
   * pointed at. An object that has left the stack by now means no question — the copy effect has
   * nothing to copy, and the resolution says so on its own terms.
   */
  readonly retargets: (state: GameState, object: StackObjectLike) => string | undefined;
  /**
   * Whether declining is an answer. Every printed card that asks this says "you **may**", so this
   * is set everywhere today — but a card that must re-aim would be a different card and the field
   * says which this is.
   */
  readonly optional?: true;
  /** Never set on this shape; the four are told apart by which of these is present. */
  readonly from?: never;
  readonly options?: never;
  readonly range?: never;
}

/**
 * What a `TargetDecisionSpec` needs off a stack object, which is its id and what it is aimed at.
 *
 * Narrower than `StackObject` on purpose: this module is below `turnTypes.ts` in the import order,
 * and a spec that asked for the whole object would drag the stack's shape into the script API for
 * the sake of two fields.
 */
export interface StackObjectLike {
  readonly id: string;
  readonly controller: SeatIndex;
  readonly targets: readonly { readonly kind: string; readonly id?: string }[];
}

export type DecisionSpec =
  | CardsDecisionSpec | ChoiceDecisionSpec | NumberDecisionSpec | TargetDecisionSpec;

/** Whether a question is the kind whose answer is a word. Narrows for TypeScript as well. */
export const isChoiceDecision = (spec: DecisionSpec): spec is ChoiceDecisionSpec =>
  spec.options !== undefined;

/** Whether a question is the kind whose answer is a number. */
export const isNumberDecision = (spec: DecisionSpec): spec is NumberDecisionSpec =>
  spec.range !== undefined;

/** Whether a question is the kind whose answer is a target for something else on the stack. */
export const isTargetDecision = (spec: DecisionSpec): spec is TargetDecisionSpec =>
  spec.retargets !== undefined;

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
   * This ability is **scheduled** rather than watched for: a delayed trigger (CR 603.7).
   *
   * `on` still says *when* — a step, which is the only shape a printed delayed trigger takes
   * ("at end of combat", "at the beginning of the next end step") — but the ordinary event path
   * never fires it. Something else creates it with `scheduleDelayed`, and the step it names drains
   * it exactly once. Without this flag a step trigger fires every turn for as long as its
   * permanent is on the battlefield, which is a different card entirely.
   */
  readonly delayed?: true;
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
   * "Exile this card from your graveyard:" — embalm's cost, and the second time the card itself is
   * what you are paying with (CR 702.89a, CR 702.100a).
   *
   * `discardSelf` one zone along in the other direction: cycling spends a card out of your hand,
   * this spends one out of your graveyard, and both are paid as the ability is activated rather
   * than when it resolves. Paying it at activation is the whole point and not a detail — embalm
   * exiles the card as a **cost**, so the same Sacred Cat cannot be embalmed twice by activating
   * it again while the first ability is still on the stack. An effect that exiled on resolution
   * would be two Cats for the price of one.
   *
   * Unlike `discardSelf`, the effect here *is* expected to read its own source: the card sits in
   * exile with its instance intact, which is what `copyAsToken` copies. It is paired with
   * `fromGraveyard`, which is what says the ability is activated from there at all — this field
   * says what the cost spends, not where the ability is used from.
   */
  readonly exileSelf?: boolean;
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
  /**
   * "Remove a +1/+1 counter from this permanent:" — a counter as the cost, not as the effect.
   *
   * The fifth cost here that is not mana, and the first paid out of the permanent's own counters.
   * The difference from an effect that removes one is the difference every cost in this list has:
   * it is paid as the ability is activated, it cannot be responded to, and an ability whose cost
   * cannot be paid is never offered — so a Walking Ballista with no counters left shows no damage
   * ability rather than one that would be refused.
   *
   * It is also what makes the last counter work the way the card does. The counter is gone before
   * the ability is on the stack, so a Ballista that removes its last one is a 0/0 that dies to a
   * state-based action while its own damage is still waiting to resolve — and the damage is dealt
   * anyway, because the ability no longer needs its source (CR 608.2). A loyalty cost is the same
   * shape and already worked this way: see `loyalty`.
   */
  readonly removeCounter?: { readonly counter: string; readonly amount: number };
  /**
   * "Pay {E}{E}:" — energy, which is a counter on the **player** rather than on a permanent
   * (CR 122.1, CR 107.17).
   *
   * The sixth cost here that is not mana, and the first paid out of something the seat owns that
   * is neither its life nor its cards. Energy is unlike every other resource this engine has in
   * one way that matters: it **does not empty**. Mana drains at the end of a step, life is a
   * number you are trying to keep, cards in a graveyard are a pile that only grows — energy is
   * saved up deliberately over several turns and then spent all at once, which makes it the first
   * resource in this pool with a *plan* attached to it.
   *
   * Stored in `Seat.counters` under the key `energy`, which that field was always for ("arbitrary
   * named counters (energy, experience, rad, tickets, ...)") and which nothing had used until now.
   * That is why the engine needed no new field for it: a counter on a player is a thing the state
   * already models, and the work is in the cost, the offer and the payment.
   *
   * The same rule as the life and the counter above: an ability whose energy you do not have is
   * never offered (CR 118.4), so a Longtusk Cub with one energy shows no growth ability rather
   * than one the engine would refuse.
   */
  readonly energy?: number;
  /**
   * "Activate this only from your graveyard" — unearth's zone, and the third thing a cost can be
   * paid out of the graveyard for (CR 702.84a).
   *
   * The sibling of `discardSelf`, which is cycling's "from your hand". Escape and delve (D171) are
   * *casts* from the graveyard and go through the cast path; unearth is not a cast at all — the
   * creature is put onto the battlefield by an **activated ability**, so nothing is put on the
   * stack, an opponent cannot counter it, and "whenever a player casts a spell" does not see it.
   * That is the whole reason it is an ability here rather than another flag on the cast path.
   */
  readonly fromGraveyard?: true;
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
   * "Activate only if …" — a restriction on the ability itself, asked where the ability is
   * *offered* rather than where it resolves.
   *
   * Monstrosity is the card shape that needs it: "Activate only if this creature isn't monstrous"
   * is the clause that makes the growth one-shot, and a creature that has already paid for it has
   * no ability left to press. Asked in `legalActions` so the table never offers it, and again in
   * the activation path so an action arriving from anywhere is refused with a reason — the same
   * two places every other ability restriction is checked in, for the reason D67 and D89 are both
   * about: an option offered and then refused is worse than an option that was never there.
   *
   * A predicate rather than data, which `ContinuousEffect.while` could not be: a script is code
   * and is never serialised, so the restriction can read whatever the card's words read.
   */
  readonly activateOnlyIf?: (state: GameState, source: string, controller: SeatIndex) => boolean;
  /**
   * "The rules let you, and it would do nothing" — read by the **bot** and by nothing else.
   *
   * The twin of `activateOnlyIf` and the opposite half of it. Monstrosity's restriction is printed
   * on the card, so the table must not offer the ability at all; **adapt's** is printed inside the
   * effect, so a player may legally pay {2}{G}{U} for a creature that already has a +1/+1 counter
   * on it and get nothing back. Both readings have to be available: the engine owes the player the
   * play the card allows, and the search owes itself not to take it.
   *
   * Measured before it existed, with one Aeromunculus in Delta Bloom: **29 casts and 88 adapt
   * activations across 34 games** — three payments per creature for one effect, and the deck lost
   * about ten games of 288 for it (D182). The sixteenth member of the drop-this-option family, and
   * the first that is about an ability rather than a card in hand.
   */
  readonly buysNothingIf?: (state: GameState, source: string, controller: SeatIndex) => boolean;
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
  /**
   * "{T}: Untap another target permanent" — an ability whose *whole* effect is untapping something.
   *
   * Declared for the bot, and the eleventh member of the "spent on nothing" family. It is the one
   * that is not about a card spent on nothing but about a **cycle**: two Kiora's Followers untap
   * each other for ever, and a board that ends where it started is a legal line the search is
   * happy with. Measured before the rule, with one copy in the deck: the ability was activated
   * **164 times across 120 games**, about three and a half per game it was drawn.
   *
   * Only for an ability that does nothing else. Maze of Ith untaps an attacking creature *and*
   * prevents its damage, and Garruk's +1 untaps two lands *and* puts a loyalty counter on him —
   * both have a payoff the question below would miss. See `untapBoughtSomething`.
   */
  readonly untapsOnly?: boolean;
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
   * X is a **number to match**, not an amount of effect: bigger is not better.
   *
   * Declared for the bot, which otherwise casts every X spell for as much as its mana allows —
   * right for a Fireball and a Mind Spring, and nonsense for a Chalice of the Void, where X is the
   * mana value the card then answers. A Chalice cast for four stops nothing anybody plays; a
   * person casts it on one.
   *
   * The search cannot tell the difference on its own, for the reason every other rule in that
   * family exists: the board after the cast is a permanent with some counters on it either way,
   * and what the number is *worth* is a fact about the cards the opponents are holding. So the
   * number is chosen from what they have actually shown. See `xToMatch` in `bot.ts`.
   */
  readonly xIsANumberToMatch?: boolean;
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
   * Escape: cast this from your graveyard for a cost that is partly mana and partly cards
   * (CR 702.139).
   *
   * The same zone flashback cast from and a different kind of cost. Flashback replaced the mana and
   * nothing else; escape says "Escape—{2}{R}{R}, Exile three other cards from your graveyard", and
   * the second half of that is the engine's first cost paid out of a **zone** rather than out of
   * the board or the mana pool. Everything already in the engine that pays a cost pays it with
   * something on the battlefield (tap it, sacrifice it, crew with it) or with a life total; the
   * graveyard was a place cards went, and escape is what makes it a resource.
   *
   * It is an **alternative cost**, so it replaces the printed one and nothing else is paid with it
   * — no kicker, no flashback, no commander tax. And unlike flashback the card is not exiled as it
   * leaves the stack: a Phoenix that escaped is an ordinary permanent, and when it dies it goes to
   * the graveyard it came from, ready to escape again for the price of three more cards. That
   * difference is the whole balance of the mechanic, and it is why escape has no `flashback` flag
   * on the stack object.
   *
   * **"Other" is load-bearing.** The card being cast is in the graveyard too, and it is not one of
   * the cards exiled for its own cost — a Phoenix of Ash with exactly three cards in the graveyard
   * including itself cannot escape, and the engine does not offer it. That is CR 601.2h territory:
   * a cost that cannot be paid is not a cost you may pay, so the play is absent rather than
   * offered and refused.
   *
   * Which cards go is the engine's to decide, the way convoke's taps are — see `graveyardFodder`
   * for the order and why it prefers cards nothing else in the deck can use.
   */
  readonly escape?: {
    /** The mana half, in the printed `{2}{R}{R}` form. */
    readonly cost: string;
    /** How many *other* cards leave the graveyard with it. */
    readonly exile: number;
  };
  /**
   * Delve: each card you exile from your graveyard while casting this pays for {1} (CR 702.112).
   *
   * The other half of escape's idea and the opposite shape. Escape is a fixed cost paid from a
   * fixed zone; delve is a **cost reduction of a size you choose as you cast**, which puts it in
   * the family X belongs to rather than the family flashback belongs to. A Gurmag Angler is a
   * {6}{B} 5/5 with eight cards in the graveyard and a {B} 5/5 with fourteen.
   *
   * Only generic mana, which is the rule rather than a simplification (CR 702.112a): a card
   * exiled this way pays for {1} and can never pay a coloured pip, so delving a {6}{B} spell
   * six times leaves {B} and never less.
   *
   * **The engine delves as little as it can get away with, not as much as it can.** The maximum
   * is free in mana and expensive in everything else — a graveyard is what the escape card, the
   * flashback card and the Gravedigger all spend — so `delvePlan` finds the *smallest* number of
   * cards that makes the spell castable and stops there. A player at a tabletop would make that
   * trade differently on different turns; an engine that always took the maximum would quietly
   * empty the resource two other mechanics in this pool are built on.
   */
  readonly delve?: true;
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
   * Evoke: cast this creature for a cheaper cost, and sacrifice it as it arrives (CR 702.74).
   *
   * The first alternative cost in this engine that changes what happens to the permanent
   * **afterwards**. Flashback, escape and foretell each replaced a cost and were done with it; a
   * Mulldrifter cast for its evoke cost is still a Mulldrifter spell, still resolves onto the
   * battlefield, still draws two cards — and then goes away, which is the whole trade. So the
   * keyword is two halves that have to be kept together: the cost, here, and the sacrifice, which
   * is an ordinary triggered ability on the card itself.
   *
   * The sacrifice is **not** in this declaration, and that is deliberate. CR 702.74a words it as
   * "When this permanent enters, if its evoke cost was paid, sacrifice it" — a triggered ability
   * with an intervening-if clause, which is a shape the engine already has. So the card carries
   * `evokeSacrifice()` in its `triggers` and the engine's only job is to record, on the permanent
   * as it arrives, that the evoke cost was what paid for it. That record is the `EVOKED` counter,
   * for the reason unearth's is: a fact about this body rather than about the card, already
   * per-permanent, already serialised, already visible.
   *
   * Which means the ETB ability the card is actually in the deck for resolves **first** and the
   * sacrifice second, because both go on the stack together and the controller orders their own
   * (CR 603.3b) — the Mulldrifter draws its two cards and only then dies. A player who read the
   * other order would be reading a card nobody would play.
   */
  readonly evoke?: {
    /** The whole cost of an evoked casting, in the printed `{1}{U}` form. */
    readonly cost: string;
  };
  /**
   * Dash: cast this creature for a cheaper cost, attack with it now, and give it back at the end
   * of the turn (CR 702.109).
   *
   * Evoke's mirror, and the second cost in this engine that changes what happens to the permanent
   * afterwards. Evoke buys the spell and gives up the body; dash buys the **body, this turn** and
   * gives up keeping it: the creature has haste, swings on the turn it arrives, and goes back to
   * its owner's hand at the beginning of the next end step — so it is the same card again next
   * turn, for the same price, and it can never be killed by anything that happens on somebody
   * else's turn.
   *
   * Both consequences are the engine's rather than the card's, which is the difference from evoke.
   * Evoke's sacrifice is a *triggered ability* printed on the card, so the card carries it; dash's
   * haste and return are part of the **resolution of the spell** (CR 702.109a) — nothing goes on
   * the stack, so nothing can be countered in between and no opponent gets a window. So
   * `completeResolution` grants the haste and schedules the return as the permanent arrives, and
   * what it writes on the permanent is the `DASHED` counter.
   *
   * The return is a **delayed trigger** (CR 603.7), which is the machinery unearth's end-step exile
   * already uses — and like unearth's, the ability lives on the card as the script's one `delayed`
   * trigger, so it gets a resolution path, a description and a place on the stack without a second
   * mechanism. A card declaring `dash` must carry exactly one, which `dashReturn()` is for and
   * which a test holds.
   */
  readonly dash?: {
    /** The whole cost of a dashed casting, in the printed `{1}{R}` form. */
    readonly cost: string;
  };
  /**
   * Bestow: cast this creature as an **Aura** for a different cost, and get the creature back when
   * the creature it enchants leaves (CR 702.103).
   *
   * The third way to cast one card for a different cost, and the first where what arrives is a
   * different *kind of permanent*. Evoke and dash change what happens to the creature afterwards;
   * this one changes what the spell **is**: a bestowed Boon Satyr is an Aura spell on the stack,
   * so "counter target creature spell" misses it, and an Enchantment — Aura on the battlefield,
   * so a board wipe misses it too. It is not a creature at all while it is attached.
   *
   * And then the half the keyword is printed for: when the enchanted creature leaves, the Aura
   * **becomes a creature** where it stands rather than going to the graveyard (CR 702.103c). That
   * is the only rule in this engine that changes a permanent's type without the permanent moving,
   * and it is what makes bestow a creature with removal insurance rather than an Aura.
   *
   * `effect` is what the enchanted creature gets, in the same vocabulary `aura` uses — a bestowed
   * card has two bodies' worth of text and this is the one that applies to somebody else. The
   * target is not declared: every card printed with bestow says "enchant creature", so the engine
   * supplies that spec rather than letting thirty cards each spell it differently.
   */
  readonly bestow?: {
    /** The whole cost of a bestowed casting, in the printed `{3}{G}{G}` form. */
    readonly cost: string;
    /** What the enchanted creature gets while this is attached to it. */
    readonly effect: PumpOptions;
  };
  /**
   * Spectacle: a cheaper cost you may pay **only if an opponent lost life this turn**
   * (CR 702.137).
   *
   * The fourth alternative cost in this engine and the first with a *condition on the game's
   * history*. Evoke, dash and bestow are always on offer; this one has to be earned, and what earns
   * it is not on the board — a player on eighteen may have been on twenty a moment ago or for four
   * turns. So it needed the engine's second fact about a turn, after storm's spell count:
   * `GameState.lifeLostThisTurn`.
   *
   * "An opponent", not "a player": your own life does not pay for it, which is the rule and also
   * the whole shape of the card — a Skewer the Critics for {R} is the second half of an attack
   * rather than a card you cast on turn one.
   *
   * There is no second effect to declare. The spell does exactly what it does for its printed
   * cost; what the keyword changes is the price and the sentence on the row that says why it is
   * being offered.
   */
  readonly spectacle?: {
    /** The whole cost of a spectacle casting, in the printed `{R}` form. */
    readonly cost: string;
  };
  /**
   * Overload: pay more and the spell stops pointing at one thing and happens to everything
   * (CR 702.96).
   *
   * The fifth alternative cost here and the first that changes **what the spell does**. Evoke and
   * dash change what happens to the permanent afterwards; bestow changes what kind of object the
   * spell is; spectacle changes only the price. This one rewrites the text: "change each instance
   * of 'target' to 'each'", so a Mizzium Mortars for {1}{R} kills one creature and the same card
   * for {3}{R}{R}{R} kills all of theirs.
   *
   * Two consequences, and they are the reason the field holds an effect rather than a number.
   *
   * The spell **targets nothing** when it is overloaded, which is not a detail: it cannot be
   * Willbendered, a ward does not see it, "sacrifice this creature when it becomes the target of a
   * spell" never fires, and it does not fizzle when the one creature worth killing is saved. So the
   * alternative carries `specs: []` the way bestow carries its own, and the overloaded play asks
   * the player nothing.
   *
   * And the effect is a different effect, so the card writes it out. The printed `onResolve` reads
   * `cardTargets`, which is empty on an overloaded cast, so a shared effect that tried to serve
   * both halves would have to branch on a flag inside every such card — and a card whose two halves
   * are two functions is the honest shape, because the two halves are two different spells with one
   * name. `completeResolution` picks between them on the stack object's `overloaded`.
   *
   * It is dearer than printed, like the kicker, and replaces the printed cost, unlike the kicker.
   */
  readonly overload?: {
    /** The whole cost of an overloaded casting, in the printed `{3}{R}{R}{R}` form. */
    readonly cost: string;
    /**
     * What the spell does when it was overloaded, instead of its printed `onResolve`.
     *
     * Runs with no targets, because an overloaded spell has none, and with the same context
     * everything else gets — so it reads the board through `battlefield` and `c.controller` the way
     * a sweeper does.
     */
    readonly onResolve: EffectFn;
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
   * What this permanent does to the **cost of other people's spells** while it is on the
   * battlefield: a Goblin Electromancer, a Thalia, a Sphere of Resistance.
   *
   * Its own declaration rather than another `statics` entry, because it is not the same kind of
   * thing: `statics` change a creature's characteristics and are read by the layer system, while
   * this changes what a *spell* costs and is read by the cost planner. Sharing a shape would mean
   * a `PumpOptions` with a mana field in it, which is the sort of union D57 warns about.
   *
   * `generic` is mana added (positive) or taken off (negative). Only generic, which is the rule
   * rather than a simplification: a reduction never touches a coloured requirement (CR 601.2f), so
   * "{1} less" on a `{U}{R}` spell changes nothing at all and a card that says otherwise is a
   * different card.
   *
   * `applies` is a predicate on the card being cast rather than an enum of spell kinds, for the
   * reason `TargetSpec.filter` is: every card words it differently — instant and sorcery, every
   * noncreature spell, artifact spells, spells with a creature type in them — and an enum would be
   * short of what the next card needs.
   */
  readonly costModifiers?: readonly {
    /**
     * Whose spells this applies to. `everyone` includes the permanent's own controller, which is
     * the whole of what makes a Thalia a cost rather than an advantage.
     */
    readonly whose: 'controller' | 'opponents' | 'everyone';
    readonly applies: (state: GameState, caster: SeatIndex, card: CardDef) => boolean;
    /** Generic mana added, or taken off when negative. */
    readonly generic: number;
    /** Shown on the play when the cost changed: "costs {1} less". */
    readonly description: string;
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
  /**
   * Madness: if you discard this card, it goes to exile instead and you may cast it for this cost
   * (CR 702.35a).
   *
   * A field rather than a `replaces` entry the card writes itself, for the reason flashback and
   * escape are fields: the **cost** has to be readable by everything that wants it. `legalActions`
   * prices the play from it, `settleOffer` asks whether it can be paid, and the bot's discard
   * policy reads it to decide that a madness card is not a discard at all but a cheap spell. A
   * cost buried inside a replacement effect's closure is a cost only that closure can see.
   *
   * The replacement itself is installed by the engine — see `replaceZoneChange` — which also keeps
   * the keyword's two halves from disagreeing: the engine that offers the cast is the engine that
   * replaced the discard.
   */
  readonly madness?: { readonly cost: string };
  /**
   * Miracle: if this is the **first card you drew this turn**, you may cast it for this cost as it
   * is drawn (CR 702.94a).
   *
   * A field rather than a trigger the card writes itself, and the shape is madness's exactly: the
   * **cost** has to be readable by everything that wants it, and the thing that offers the cast is
   * the engine rather than the card. `settle` raises the offer as it drains the draws, which is the
   * only moment the engine knows a card was *drawn* rather than put into a hand, and `settleOffer`
   * asks whether the cost can be paid before stopping the table with a one-button question.
   *
   * It is the first cost in this engine conditioned on **when in the turn** a card arrived. The
   * three things it needs are a draw that says which card it was, a count of the turn's draws, and
   * an offer that leaves the card where it is when declined — `GameState.drew`'s `nth`,
   * `GameState.cardsDrawnThisTurn` and `pendingOfferedCast.stays`.
   *
   * What it deliberately does not model is the **reveal**. The printed card is revealed from your
   * hand as you draw it, whether or not you then cast it; here the offer is a question put to its
   * own seat and the opponent learns the card only if it is cast. That is a hidden-information
   * difference in the player's favour and it is small — but it is a difference, and a card that
   * punished an opponent for the reveal would need the reveal to be real.
   */
  readonly miracle?: { readonly cost: string };
  /**
   * Rebound: cast it from your hand and it comes back next turn, for nothing (CR 702.88).
   *
   * The fourth card in the engine that is cast twice and the first that pays for the second casting
   * with **time** rather than with a cost. Flashback charges a second price; escape charges mana and
   * a graveyard; madness and miracle charge less than the printed cost once. Rebound charges
   * nothing at all — and the reason it is fair is that you have to still be alive next turn, and
   * your opponent gets a whole turn in between to make the second copy matter less.
   *
   * `true` rather than a cost, because there is no cost: everything about the keyword is the
   * engine's. As the spell resolves it goes to **exile** instead of to the graveyard, and the card
   * schedules a delayed trigger for its controller's next upkeep (CR 603.7) whose resolution offers
   * the free cast — so a card declaring `rebound` must carry exactly one `delayed` upkeep trigger,
   * which `reboundCast()` is for and which a test holds. The same arrangement dash and unearth use:
   * the ability lives on the card, so it gets a description, a place on the stack and a resolution
   * path without a second mechanism.
   *
   * Two halves of the rule are load-bearing and both are about the *second* casting. It only
   * happens if the spell was cast **from a hand** — see `StackObject.rebounding` — so the rebound
   * cast, which comes from exile, does not rebound again. And declining leaves the card in exile
   * for good: `pendingOfferedCast.stays` is miracle's flag doing a second job, because "do not move
   * it" is the same disposition whether the card is sitting in a hand or in an exile.
   *
   * What it deliberately does not model is the one-shot nature of the *offer* beyond the exile: a
   * card still in exile when its upkeep comes round again is not offered twice, because the delayed
   * trigger is consumed when it resolves and nothing schedules another.
   */
  readonly rebound?: true;
  /**
   * Replicate: pay this cost as many times as you like, and copy the spell for each (CR 702.56).
   *
   * The engine's first cost that can be paid **more than once on one casting**, and the first
   * number announced as a spell is cast that is not {X}. Everything else in the cost family is a
   * yes or a no: a kicker is paid or not, an alternative cost replaces the printed one or does not.
   * This is a count, and what it buys is copies rather than a bigger effect.
   *
   * Offered as **one play per count** rather than as a number picker, which is the kicker's
   * arrangement rather than {X}'s and is deliberate. The table already draws a second play on the
   * same card with a different cost; a count whose ceiling is the mana available is exactly that
   * list, one entry per affordable number, and it needs nothing new in the client. {X}'s picker
   * exists because X ranges to twenty; replicate in this pool ranges to three.
   *
   * The copies are the card's own **self spell-cast trigger**, the shape storm uses
   * (`replicate()`), reading the count off `StackObject.replicated`. Each copy keeps the original's
   * targets and its division, like storm's: the printed card offers new targets for the copies and
   * the engine does not, which is the narrower reading and the one that cannot be wrong in the
   * player's favour.
   */
  readonly replicate?: { readonly cost: string };
  readonly replaces?: readonly {
    /**
     * Which zone change this replaces. The three are the same move seen at three widths, and a
     * card that says the widest one really does mean it:
     *
     * - `dies` — a permanent going to a graveyard **from the battlefield** (CR 700.4). Kalitas.
     * - `to-graveyard` — a card going to a graveyard **from anywhere**: a death, a discard, a
     *   mill, a spell finishing its resolution. Rest in Peace, Leyline of the Void.
     * - `leaves-battlefield` — a permanent going anywhere that is not another battlefield: dying,
     *   exiled, bounced, sacrificed. Unearth's "or if it would leave the battlefield".
     *
     * **One move is replaced once, and the widest applicable wording wins.** A creature dying
     * while an opponent has a Leyline of the Void is one event, and whichever effect replaces it
     * the creature is exiled and did not die — so no death trigger fires and nothing sees a card
     * reaching a graveyard. `settle` therefore asks the wide wordings first and drops the ids they
     * handled out of the narrower lists; see `replaceZoneChange`.
     */
    readonly on: ReplacementEvent;
    readonly description: string;
    readonly applies: (ctx: ReplacementContext) => boolean;
    readonly instead: (ctx: ReplacementContext) => GameState;
  }[];
}

/** The zone changes a card's `replaces` entry can be written against. See `CardScript.replaces`. */
export type ReplacementEvent = 'dies' | 'to-graveyard' | 'leaves-battlefield';

/**
 * What a replacement effect is asked about: the card it is replacing the event for, and the
 * permanent whose effect this is.
 *
 * `subject` has **already made the move** by the time this runs — it is in the graveyard, the hand
 * or the exile it was heading for — which is the shape of the engine's answer to replacement
 * effects generally; see `settle`. Read it for what the card *was*, not for where it is, and read
 * `state.vanished[subject]` when what matters is the counters it was carrying on the battlefield.
 */
export interface ReplacementContext {
  readonly state: GameState;
  /** The card the event is happening to. */
  readonly subject: string;
  /** The permanent whose replacement effect this is. */
  readonly source: string;
  /** Who controls `source`. */
  readonly controller: SeatIndex;
  /**
   * Whether the move being replaced was a **discard**: a card going from a hand to a graveyard.
   *
   * Only madness asks (CR 702.35a), and only madness could: a Fiery Temper milled off the top of a
   * library, or put into a graveyard after resolving as a spell, is in the same `to-graveyard` list
   * as one that was discarded, and the card is already in the graveyard by the time this runs — so
   * the zone it came from is not readable from the board. See `GameState.discarded`.
   */
  readonly discarded: boolean;
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
