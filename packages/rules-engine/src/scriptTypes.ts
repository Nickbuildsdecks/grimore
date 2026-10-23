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
import type { Step, Target } from './turnTypes.js';

/** What a spell or ability needs pointed at it before it can be put on the stack. */
export interface TargetSpec {
  /**
   * What may be pointed at. `graveyard-creature` is a creature *card* in a graveyard rather than a
   * creature on the battlefield — a different object in a different zone, which is why it is its
   * own kind rather than a filter on `creature`.
   */
  readonly kind: 'creature' | 'permanent' | 'player' | 'any' | 'spell' | 'graveyard-creature';
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
  | { readonly kind: 'etb' }
  | { readonly kind: 'dies' }
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

export interface TriggerDef {
  readonly on: TriggerEvent;
  readonly description: string;
  readonly targets?: readonly TargetSpec[];
  readonly effect: EffectFn;
}

export interface AbilityCost {
  /** Mana part, in the printed `{1}{R}` form. */
  readonly mana?: string;
  /** The `{T}` symbol: requires the permanent to be untapped and not summoning sick. */
  readonly tap?: boolean;
  readonly sacrificeSelf?: boolean;
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
  readonly effect?: EffectFn;
  /** Only activatable when you could cast a sorcery. */
  readonly sorcerySpeed?: boolean;
}

/** An Aura: what it may enchant, and what it does to the thing it is attached to. */
export interface AuraDef {
  readonly target: TargetSpec;
  readonly effect: PumpOptions;
}

export interface CardScript {
  /** Matched case-insensitively against the card's printed name. */
  readonly name: string;
  /** Keywords the card has, overriding what would be read from its oracle text. */
  readonly keywords?: readonly Keyword[];
  /** What the spell targets when cast. */
  readonly targets?: readonly TargetSpec[];
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
