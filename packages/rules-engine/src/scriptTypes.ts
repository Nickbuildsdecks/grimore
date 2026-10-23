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
import type { DecisionZone, Step, Target } from './turnTypes.js';

/** What a spell or ability needs pointed at it before it can be put on the stack. */
export interface TargetSpec {
  /**
   * What may be pointed at. The `graveyard-*` kinds point at a *card* in a graveyard rather than a
   * permanent on the battlefield — a different object in a different zone, which is why they are
   * their own kinds rather than a filter on `creature`. A card in a graveyard has no continuous
   * effects applied to it, so its **printed** type is what it is; `graveyard-card` takes any card
   * and leaves the rest to `filter`.
   */
  readonly kind:
    | 'creature' | 'permanent' | 'player' | 'any' | 'spell'
    | 'graveyard-creature' | 'graveyard-land' | 'graveyard-card';
  /** Shown to the player choosing, e.g. "target creature an opponent controls". */
  readonly description: string;
  /** How many of this spec. Defaults to 1. */
  readonly count?: number;
  /** "up to": the spell is castable with fewer, including none. */
  readonly optional?: boolean;
  /** Extra restriction beyond the kind, e.g. only creatures you control. */
  readonly filter?: (state: GameState, candidate: Target, controller: SeatIndex) => boolean;
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
       */
      readonly what?: 'creature' | 'permanent';
      /** Set by the engine when it raises the event. */
      readonly subjectSeat?: SeatIndex;
      /** Set by the engine when it raises the event: whether the subject is a creature. */
      readonly subjectIsCreature?: boolean;
    }
  | {
      readonly kind: 'dies';
      /** As `etb`: `self` is this creature dying, `another` is any other, `any` is both. */
      readonly who?: 'self' | 'another' | 'any';
      readonly of?: 'you' | 'opponent' | 'any';
      readonly what?: 'creature' | 'permanent';
      readonly subjectSeat?: SeatIndex;
      readonly subjectIsCreature?: boolean;
    }
  | { readonly kind: 'attacks' }
  | { readonly kind: 'becomes-tapped' }
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
  | { readonly kind: 'life-gained'; readonly by?: 'you' | 'any' }
  | { readonly kind: 'step'; readonly step: Step; readonly of?: 'you' | 'any' };

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
export interface DecisionSpec {
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
}

export interface TriggerDef {
  readonly on: TriggerEvent;
  readonly description: string;
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
  readonly triggers?: readonly TriggerDef[];
  readonly abilities?: readonly AbilityDef[];
  /** Static effects the permanent creates while it is on the battlefield. */
  readonly statics?: readonly {
    readonly scope: 'self' | 'controller-creatures' | 'all-creatures';
    readonly effect: PumpOptions;
  }[];
}

export const targetCount = (spec: TargetSpec): number => Math.max(1, spec.count ?? 1);
